import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UploadError, createFilesClient } from "./files";

// Minimal XMLHttpRequest stub — Bun runs this test outside a real browser.
// We model the surface the upload helper uses: open/send/setRequestHeader,
// onload/onerror/onabort/ontimeout, upload.onprogress, abort(), status,
// responseText. Tests drive the lifecycle by calling helpers on the instance.
//
// Two paths share this stub: single-shot POST /upload and chunked init →
// patch → finalize. Chunked paths produce multiple sequential XHRs; tests
// drive them by awaiting `nextXhr()` between responses.

interface StubHeaders {
  Authorization?: string;
  "X-Plugin"?: string;
  "X-Filename"?: string;
  "Content-Type"?: string;
}

class StubXhr {
  // Spec surface
  status = 0;
  responseText = "";
  responseType = "";
  upload: { onprogress: ((ev: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  // Captured by tests
  method = "";
  url = "";
  headers: StubHeaders = {};
  body: BodyInit | null = null;
  aborted = false;

  open(method: string, url: string, _async: boolean): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    (this.headers as Record<string, string>)[name] = value;
  }
  send(body: BodyInit | null): void {
    this.body = body;
    StubXhr.lastInstance = this;
    StubXhr.instances.push(this);
  }
  abort(): void {
    this.aborted = true;
    queueMicrotask(() => this.onabort?.());
  }

  // ---- Test helpers ----
  finishSuccess(payload: Record<string, unknown>): void {
    this.status = 201;
    this.responseText = JSON.stringify(payload);
    queueMicrotask(() => this.onload?.());
  }
  finishOk(payload: Record<string, unknown>): void {
    this.status = 200;
    this.responseText = JSON.stringify(payload);
    queueMicrotask(() => this.onload?.());
  }
  finishError(status: number, body: string | Record<string, unknown>): void {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    queueMicrotask(() => this.onload?.());
  }
  fireNetworkError(): void {
    queueMicrotask(() => this.onerror?.());
  }
  fireProgress(loaded: number, total: number, lengthComputable = true): void {
    const ev = {
      loaded,
      total,
      lengthComputable,
    } as unknown as ProgressEvent;
    this.upload.onprogress?.(ev);
  }

  static lastInstance: StubXhr | null = null;
  static instances: StubXhr[] = [];
}

/** Flush microtasks until a fresh XHR appears (or time out). */
async function nextXhr(prev: StubXhr | null): Promise<StubXhr> {
  for (let i = 0; i < 100; i++) {
    await Promise.resolve();
    if (StubXhr.lastInstance !== prev && StubXhr.lastInstance !== null) {
      return StubXhr.lastInstance;
    }
  }
  throw new Error("timed out waiting for next XHR");
}

let savedXhr: typeof XMLHttpRequest;
let savedSetTimeout: typeof setTimeout;
let savedClearTimeout: typeof clearTimeout;

interface FakeTimer { cancelled: boolean }

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  savedXhr = (globalThis as any).XMLHttpRequest;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).XMLHttpRequest = StubXhr;
  StubXhr.lastInstance = null;
  StubXhr.instances = [];

  // Make the SDK's retry backoff sleep() resolve on the next microtask so
  // the chunked-path retry tests don't sit on real 1s/2s/4s delays. We keep
  // clearTimeout semantics intact so abort-during-sleep still works.
  savedSetTimeout = globalThis.setTimeout;
  savedClearTimeout = globalThis.clearTimeout;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).setTimeout = (fn: () => void, _ms: number): FakeTimer => {
    const token: FakeTimer = { cancelled: false };
    queueMicrotask(() => {
      if (!token.cancelled) fn();
    });
    return token;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).clearTimeout = (token: unknown): void => {
    if (token && typeof token === "object" && "cancelled" in token) {
      (token as FakeTimer).cancelled = true;
    }
  };
});
afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).XMLHttpRequest = savedXhr;
  globalThis.setTimeout = savedSetTimeout;
  globalThis.clearTimeout = savedClearTimeout;
});

function makeFile(bytes: number, name = "test.bin", mime = "application/octet-stream"): File {
  const buf = new Uint8Array(bytes);
  return new File([buf as BlobPart], name, { type: mime });
}

function makeClient() {
  return createFilesClient({ token: "tok", slug: "text-channels", runtimeOrigin: "https://rt.example" });
}

describe("createFilesClient.upload (single-shot path)", () => {
  test("sends POST /upload with required headers and resolves on 201", async () => {
    const client = makeClient();
    const file = makeFile(16, "photo.png", "image/png");

    const pending = client.upload(file);
    // Wait for synchronous open/send.
    await Promise.resolve();
    const xhr = StubXhr.lastInstance!;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("https://rt.example/upload");
    expect(xhr.headers["Authorization"]).toBe("Bearer tok");
    expect(xhr.headers["X-Plugin"]).toBe("text-channels");
    expect(xhr.headers["X-Filename"]).toBe(encodeURIComponent("photo.png"));
    expect(xhr.headers["Content-Type"]).toBe("application/octet-stream");
    expect(xhr.body).toBe(file);

    xhr.finishSuccess({
      ok: true,
      filename: "abc.png",
      size: 16,
      mime: "image/png",
      originalName: "photo.png",
    });

    const result = await pending;
    expect(result.filename).toBe("abc.png");
    expect(result.size).toBe(16);
    expect(result.mime).toBe("image/png");
    expect(result.originalName).toBe("photo.png");
  });

  test("rejects empty files before opening XHR", async () => {
    const client = makeClient();
    const empty = makeFile(0, "zero.txt");
    await expect(client.upload(empty)).rejects.toMatchObject({
      name: "UploadError",
      code: "EMPTY_BODY",
    });
    expect(StubXhr.lastInstance).toBeNull();
  });

  test("rejects files over maxBytes client-side", async () => {
    const client = makeClient();
    const big = makeFile(2048, "big.bin");
    await expect(client.upload(big, { maxBytes: 1024 })).rejects.toMatchObject({
      name: "UploadError",
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(StubXhr.lastInstance).toBeNull();
  });

  test("rejects non-Blob arguments", async () => {
    const client = makeClient();
    await expect(
      client.upload("not a blob" as unknown as Blob),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  test("forwards progress events with computed ratio", async () => {
    const client = makeClient();
    const file = makeFile(1000);
    const progress: number[] = [];
    const pending = client.upload(file, {
      onProgress: ({ ratio }) => progress.push(ratio),
    });
    await Promise.resolve();
    const xhr = StubXhr.lastInstance!;
    xhr.fireProgress(250, 1000);
    xhr.fireProgress(500, 1000);
    xhr.fireProgress(1000, 1000);
    xhr.finishSuccess({ ok: true, filename: "x", size: 1000, mime: "application/octet-stream" });
    await pending;
    expect(progress).toEqual([0.25, 0.5, 1]);
  });

  test("clamps progress ratio to [0,1] and falls back to file size when lengthComputable is false", async () => {
    const client = makeClient();
    const file = makeFile(800);
    let captured: { loaded: number; total: number; ratio: number } | null = null;
    const pending = client.upload(file, {
      onProgress: (p) => { captured = p; },
    });
    await Promise.resolve();
    const xhr = StubXhr.lastInstance!;
    xhr.fireProgress(400, 0, false); // lengthComputable false → fall back to file.size
    expect(captured).not.toBeNull();
    const c = captured as unknown as { loaded: number; total: number; ratio: number };
    expect(c.total).toBe(800);
    expect(c.ratio).toBe(0.5);
    xhr.finishSuccess({ ok: true, filename: "x", size: 800, mime: "application/octet-stream" });
    await pending;
  });

  test("isolates throwing progress handler so upload still resolves", async () => {
    const client = makeClient();
    const file = makeFile(100);
    const pending = client.upload(file, {
      onProgress: () => { throw new Error("boom"); },
    });
    await Promise.resolve();
    const xhr = StubXhr.lastInstance!;
    xhr.fireProgress(50, 100);
    xhr.finishSuccess({ ok: true, filename: "x", size: 100, mime: "application/octet-stream" });
    await expect(pending).resolves.toMatchObject({ filename: "x" });
  });

  test("maps non-201 envelope errors to UploadError with code", async () => {
    const client = makeClient();
    const file = makeFile(10);
    const pending = client.upload(file);
    await Promise.resolve();
    const xhr = StubXhr.lastInstance!;
    xhr.finishError(413, { error: { code: "PAYLOAD_TOO_LARGE", message: "File too big" } });
    await expect(pending).rejects.toMatchObject({
      name: "UploadError",
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
    });
  });

  test("falls back to HTTP-status-derived code when body isn't a JSON envelope", async () => {
    const client = makeClient();
    const file = makeFile(10);
    const pending = client.upload(file);
    await Promise.resolve();
    const xhr = StubXhr.lastInstance!;
    xhr.finishError(401, "");
    await expect(pending).rejects.toMatchObject({
      name: "UploadError",
      code: "UNAUTHORIZED",
      status: 401,
    });
  });

  test("rejects with MALFORMED_RESPONSE on 201 with bad JSON", async () => {
    const client = makeClient();
    const file = makeFile(10);
    const pending = client.upload(file);
    await Promise.resolve();
    const xhr = StubXhr.lastInstance!;
    xhr.finishError(201, "not json");
    await expect(pending).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  test("rejects with NETWORK_ERROR on xhr.onerror", async () => {
    const client = makeClient();
    const file = makeFile(10);
    const pending = client.upload(file);
    await Promise.resolve();
    const xhr = StubXhr.lastInstance!;
    xhr.fireNetworkError();
    await expect(pending).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  test("AbortSignal already aborted rejects before sending", async () => {
    const client = makeClient();
    const file = makeFile(10);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(client.upload(file, { signal: ctrl.signal })).rejects.toMatchObject({
      code: "ABORTED",
    });
    expect(StubXhr.lastInstance).toBeNull();
  });

  test("AbortSignal aborts in-flight upload", async () => {
    const client = makeClient();
    const file = makeFile(10);
    const ctrl = new AbortController();
    const pending = client.upload(file, { signal: ctrl.signal });
    await Promise.resolve();
    const xhr = StubXhr.lastInstance!;
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(xhr.aborted).toBe(true);
  });

  test("UploadError exposes code/status fields", () => {
    const err = new UploadError("X", "y", 418);
    expect(err.code).toBe("X");
    expect(err.message).toBe("y");
    expect(err.status).toBe(418);
    expect(err instanceof Error).toBe(true);
  });
});

// Threshold for fast-path / chunked-path dispatch (spec-26 Amendment A).
const SINGLE_SHOT_THRESHOLD = 50 * 1024 * 1024;

describe("createFilesClient.upload (chunked path)", () => {
  test("file exactly at SINGLE_SHOT_THRESHOLD takes single-shot path", async () => {
    const client = makeClient();
    const file = makeFile(SINGLE_SHOT_THRESHOLD, "right-at.bin");

    const pending = client.upload(file);
    await Promise.resolve();
    const xhr = StubXhr.lastInstance!;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("https://rt.example/upload");
    xhr.finishSuccess({
      ok: true,
      filename: "abc.bin",
      size: SINGLE_SHOT_THRESHOLD,
      mime: "application/octet-stream",
    });
    const result = await pending;
    expect(result.filename).toBe("abc.bin");
    expect(StubXhr.instances).toHaveLength(1);
  });

  test("file one byte over threshold takes chunked path", async () => {
    const client = makeClient();
    const file = makeFile(SINGLE_SHOT_THRESHOLD + 1, "just-over.bin");

    const pending = client.upload(file);
    const initXhr = await nextXhr(null);
    expect(initXhr.method).toBe("POST");
    expect(initXhr.url).toBe("https://rt.example/upload/init");
    expect(initXhr.headers["Authorization"]).toBe("Bearer tok");
    expect(initXhr.headers["X-Plugin"]).toBe("text-channels");
    expect(initXhr.headers["Content-Type"]).toBe("application/json");

    // Tell the server to use a chunk_size equal to the file size so there's
    // exactly one PATCH — keeps the test fast without re-slicing.
    initXhr.finishOk({
      upload_id: "00000000-0000-0000-0000-000000000001",
      chunk_size: SINGLE_SHOT_THRESHOLD + 1,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      received_bytes: 0,
    });

    const patchXhr = await nextXhr(initXhr);
    expect(patchXhr.method).toBe("PATCH");
    expect(patchXhr.url).toBe("https://rt.example/upload/00000000-0000-0000-0000-000000000001?offset=0");
    patchXhr.finishOk({ received_bytes: SINGLE_SHOT_THRESHOLD + 1, chunk_size: SINGLE_SHOT_THRESHOLD + 1 });

    const finalXhr = await nextXhr(patchXhr);
    expect(finalXhr.method).toBe("POST");
    expect(finalXhr.url).toBe("https://rt.example/upload/00000000-0000-0000-0000-000000000001/finalize");
    finalXhr.finishSuccess({
      ok: true,
      filename: "abc.bin",
      size: SINGLE_SHOT_THRESHOLD + 1,
      mime: "application/octet-stream",
    });

    const result = await pending;
    expect(result.filename).toBe("abc.bin");
  });

  test("init → 3 chunks → finalize, with aggregated progress across chunks", async () => {
    const client = makeClient();
    const TOTAL = SINGLE_SHOT_THRESHOLD + 3;
    const CHUNK = Math.ceil(TOTAL / 3);
    const file = makeFile(TOTAL, "three.bin");

    const ratios: number[] = [];
    const pending = client.upload(file, {
      onProgress: ({ ratio }) => ratios.push(ratio),
    });

    const initXhr = await nextXhr(null);
    initXhr.finishOk({
      upload_id: "00000000-0000-0000-0000-000000000002",
      chunk_size: CHUNK,
      expires_at: 0,
      received_bytes: 0,
    });

    // Chunk 1 — progress to half-of-chunk and chunk-end.
    let prev = initXhr;
    let received = 0;
    for (let i = 0; i < 3; i++) {
      const chunkEnd = Math.min(received + CHUNK, TOTAL);
      const chunkBytes = chunkEnd - received;
      const xhr = await nextXhr(prev);
      expect(xhr.method).toBe("PATCH");
      expect(xhr.url).toBe(
        `https://rt.example/upload/00000000-0000-0000-0000-000000000002?offset=${String(received)}`,
      );
      // Fire one mid-chunk progress event.
      xhr.fireProgress(Math.floor(chunkBytes / 2), chunkBytes);
      xhr.finishOk({ received_bytes: chunkEnd, chunk_size: CHUNK });
      received = chunkEnd;
      prev = xhr;
    }

    const finalXhr = await nextXhr(prev);
    expect(finalXhr.method).toBe("POST");
    finalXhr.finishSuccess({
      ok: true,
      filename: "abc.bin",
      size: TOTAL,
      mime: "application/octet-stream",
    });

    const result = await pending;
    expect(result.size).toBe(TOTAL);
    // Each chunk fires one progress event with loaded = chunkOffset + ~half-chunk.
    // Ratios must be strictly non-decreasing.
    expect(ratios.length).toBe(3);
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i]).toBeGreaterThan(ratios[i - 1]!);
    }
    expect(ratios[2]).toBeLessThanOrEqual(1);
  });

  test("PATCH 5xx triggers retry with onRetry callback", async () => {
    const client = makeClient();
    const TOTAL = SINGLE_SHOT_THRESHOLD + 1;
    const file = makeFile(TOTAL, "retry.bin");
    const retries: number[] = [];

    const pending = client.upload(file, { onRetry: (n) => retries.push(n) });

    const initXhr = await nextXhr(null);
    initXhr.finishOk({
      upload_id: "00000000-0000-0000-0000-000000000003",
      chunk_size: TOTAL,
      expires_at: 0,
      received_bytes: 0,
    });

    const patch1 = await nextXhr(initXhr);
    patch1.finishError(503, { error: { code: "INTERNAL", message: "server hiccup" } });

    // SDK should retry — same offset, new XHR.
    const patch2 = await nextXhr(patch1);
    expect(patch2.method).toBe("PATCH");
    expect(patch2.url).toBe("https://rt.example/upload/00000000-0000-0000-0000-000000000003?offset=0");
    patch2.finishOk({ received_bytes: TOTAL, chunk_size: TOTAL });

    const finalXhr = await nextXhr(patch2);
    finalXhr.finishSuccess({
      ok: true,
      filename: "ok.bin",
      size: TOTAL,
      mime: "application/octet-stream",
    });

    await pending;
    expect(retries).toEqual([1]);
  }, 30000);

  test("PATCH 409 RANGE_CONFLICT triggers GET resync and retry from server offset", async () => {
    const client = makeClient();
    const TOTAL = SINGLE_SHOT_THRESHOLD + 100;
    const HALF = Math.floor(TOTAL / 2);
    const file = makeFile(TOTAL, "conflict.bin");
    const retries: number[] = [];

    const pending = client.upload(file, { onRetry: (n) => retries.push(n) });

    const initXhr = await nextXhr(null);
    // Pretend chunk_size is the full file so we'd do one PATCH at offset 0.
    initXhr.finishOk({
      upload_id: "00000000-0000-0000-0000-000000000004",
      chunk_size: TOTAL,
      expires_at: 0,
      received_bytes: 0,
    });

    // First PATCH at offset 0 — server says "I actually have HALF bytes already".
    const patch1 = await nextXhr(initXhr);
    expect(patch1.url).toContain("offset=0");
    patch1.finishError(409, {
      error: { code: "RANGE_CONFLICT", message: "offset less than received_bytes" },
    });

    // SDK fetches status to resync.
    const statusXhr = await nextXhr(patch1);
    expect(statusXhr.method).toBe("GET");
    expect(statusXhr.url).toBe("https://rt.example/upload/00000000-0000-0000-0000-000000000004");
    statusXhr.finishOk({ received_bytes: HALF, total_bytes: TOTAL, expires_at: 0 });

    // SDK retries the remaining bytes from HALF.
    const patch2 = await nextXhr(statusXhr);
    expect(patch2.url).toContain(`offset=${String(HALF)}`);
    patch2.finishOk({ received_bytes: TOTAL, chunk_size: TOTAL });

    const finalXhr = await nextXhr(patch2);
    finalXhr.finishSuccess({
      ok: true,
      filename: "ok.bin",
      size: TOTAL,
      mime: "application/octet-stream",
    });

    await pending;
    expect(retries).toEqual([1]);
  }, 30000);

  test("PATCH 410 UPLOAD_EXPIRED rejects immediately (no retry)", async () => {
    const client = makeClient();
    const TOTAL = SINGLE_SHOT_THRESHOLD + 1;
    const file = makeFile(TOTAL, "expired.bin");

    const pending = client.upload(file);

    const initXhr = await nextXhr(null);
    initXhr.finishOk({
      upload_id: "00000000-0000-0000-0000-000000000005",
      chunk_size: TOTAL,
      expires_at: 0,
      received_bytes: 0,
    });

    const patch1 = await nextXhr(initXhr);
    patch1.finishError(410, {
      error: { code: "UPLOAD_EXPIRED", message: "session expired" },
    });

    await expect(pending).rejects.toMatchObject({
      name: "UploadError",
      code: "UPLOAD_EXPIRED",
      status: 410,
    });
    // No retry attempt issued.
    const all = StubXhr.instances.filter((x) => x.method === "PATCH");
    expect(all).toHaveLength(1);
  });

  test("PATCH 416 RANGE_NOT_SATISFIABLE rejects immediately (no retry)", async () => {
    const client = makeClient();
    const TOTAL = SINGLE_SHOT_THRESHOLD + 1;
    const file = makeFile(TOTAL, "range.bin");

    const pending = client.upload(file);

    const initXhr = await nextXhr(null);
    initXhr.finishOk({
      upload_id: "00000000-0000-0000-0000-000000000006",
      chunk_size: TOTAL,
      expires_at: 0,
      received_bytes: 0,
    });

    const patch1 = await nextXhr(initXhr);
    patch1.finishError(416, {
      error: { code: "RANGE_NOT_SATISFIABLE", message: "offset past received_bytes" },
    });

    await expect(pending).rejects.toMatchObject({
      name: "UploadError",
      code: "RANGE_NOT_SATISFIABLE",
      status: 416,
    });
    const all = StubXhr.instances.filter((x) => x.method === "PATCH");
    expect(all).toHaveLength(1);
  });

  test("PATCH 401 UNAUTHORIZED rejects immediately (permanent error)", async () => {
    const client = makeClient();
    const TOTAL = SINGLE_SHOT_THRESHOLD + 1;
    const file = makeFile(TOTAL, "auth.bin");

    const pending = client.upload(file);

    const initXhr = await nextXhr(null);
    initXhr.finishOk({
      upload_id: "00000000-0000-0000-0000-000000000007",
      chunk_size: TOTAL,
      expires_at: 0,
      received_bytes: 0,
    });

    const patch1 = await nextXhr(initXhr);
    patch1.finishError(401, "");

    await expect(pending).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });
    const all = StubXhr.instances.filter((x) => x.method === "PATCH");
    expect(all).toHaveLength(1);
  });

  test("finalize 422 INTEGRITY_FAILED surfaces as INTEGRITY_FAILED", async () => {
    const client = makeClient();
    const TOTAL = SINGLE_SHOT_THRESHOLD + 1;
    const file = makeFile(TOTAL, "integrity.bin");

    const pending = client.upload(file);

    const initXhr = await nextXhr(null);
    initXhr.finishOk({
      upload_id: "00000000-0000-0000-0000-000000000008",
      chunk_size: TOTAL,
      expires_at: 0,
      received_bytes: 0,
    });

    const patchXhr = await nextXhr(initXhr);
    patchXhr.finishOk({ received_bytes: TOTAL, chunk_size: TOTAL });

    const finalXhr = await nextXhr(patchXhr);
    finalXhr.finishError(422, {
      error: { code: "INTEGRITY_FAILED", message: "size mismatch" },
    });

    await expect(pending).rejects.toMatchObject({
      code: "INTEGRITY_FAILED",
      status: 422,
    });
  });

  test("init returns PAYLOAD_TOO_LARGE → rejects without retry", async () => {
    const client = makeClient();
    const TOTAL = SINGLE_SHOT_THRESHOLD + 1;
    const file = makeFile(TOTAL, "too-big.bin");

    const pending = client.upload(file);

    const initXhr = await nextXhr(null);
    initXhr.finishError(413, {
      error: { code: "PAYLOAD_TOO_LARGE", message: "plugin caps below file size" },
    });

    await expect(pending).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
    });
    expect(StubXhr.instances).toHaveLength(1);
  });

  test("abort during chunked upload aborts in-flight PATCH and fires DELETE /upload/<id>", async () => {
    const client = makeClient();
    const TOTAL = SINGLE_SHOT_THRESHOLD + 1;
    const file = makeFile(TOTAL, "aborty.bin");

    const ctrl = new AbortController();
    const pending = client.upload(file, { signal: ctrl.signal });

    const initXhr = await nextXhr(null);
    initXhr.finishOk({
      upload_id: "00000000-0000-0000-0000-000000000009",
      chunk_size: TOTAL,
      expires_at: 0,
      received_bytes: 0,
    });

    const patchXhr = await nextXhr(initXhr);
    expect(patchXhr.method).toBe("PATCH");
    ctrl.abort();

    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(patchXhr.aborted).toBe(true);

    // DELETE fires best-effort. The DELETE XHR may resolve after the
    // promise rejects, so flush microtasks before asserting it exists.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const del = StubXhr.instances.find(
      (x) => x.method === "DELETE" && x.url === "https://rt.example/upload/00000000-0000-0000-0000-000000000009",
    );
    expect(del).toBeDefined();
  });

  test("init JSON body includes total_bytes and original_name", async () => {
    const client = makeClient();
    const TOTAL = SINGLE_SHOT_THRESHOLD + 1;
    const file = makeFile(TOTAL, "named.jpg", "image/jpeg");

    const pending = client.upload(file);
    const initXhr = await nextXhr(null);
    expect(initXhr.method).toBe("POST");
    expect(initXhr.url).toBe("https://rt.example/upload/init");
    const body = JSON.parse(initXhr.body as string) as Record<string, unknown>;
    expect(body["total_bytes"]).toBe(TOTAL);
    expect(body["original_name"]).toBe("named.jpg");

    initXhr.finishOk({
      upload_id: "00000000-0000-0000-0000-00000000000a",
      chunk_size: TOTAL,
      expires_at: 0,
      received_bytes: 0,
    });

    const patchXhr = await nextXhr(initXhr);
    patchXhr.finishOk({ received_bytes: TOTAL, chunk_size: TOTAL });

    const finalXhr = await nextXhr(patchXhr);
    finalXhr.finishSuccess({
      ok: true, filename: "abc.jpg", size: TOTAL, mime: "image/jpeg",
    });

    await pending;
  });
});
