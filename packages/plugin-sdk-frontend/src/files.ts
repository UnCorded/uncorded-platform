// File-attachments client — iframe-side helper for plugins that need to upload
// user-selected files to their plugin's storage area on the runtime.
//
// The iframe is loaded directly from the runtime origin (`iframe.src =
// "${tunnelUrl}/plugins/${slug}/ui/"`), so `window.location.origin` is the
// runtime origin even when the iframe is sandboxed without `allow-same-origin`
// — and POST /upload accepts wildcard CORS with `Origin: null`.
//
// Auth is the iframe's bearer token (issued at handshake, refreshed by the
// shell). The X-Plugin header pins the upload to the manifest-declared slug
// so the runtime can enforce `storage.file:self`. The server picks the final
// on-disk filename (UUID + sniffed extension); the X-Filename header carries
// only the original display name for the plugin's DB.
//
// Two paths (spec-26 Amendment A):
//   * Single-shot POST /upload for files ≤ SINGLE_SHOT_THRESHOLD (50 MB) —
//     avoids protocol overhead on screenshots/emoji.
//   * Chunked init→patch→finalize for larger files — resilient to network
//     blips and idle-timeouts on multi-GB uploads, 5 GB ceiling.
//
// Production guarantees (both paths):
//   * progress events from XHR (fetch streams aren't widely supported yet)
//   * AbortSignal cancellation that aborts the in-flight request
//   * structured UploadError with .code matching the server contract
//   * size pre-check against a caller-supplied ceiling, so the UI can reject
//     5 GB drops before any bytes leave the browser

const RUNTIME_HARD_CEILING_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB (spec-26 Amendment A)
const SINGLE_SHOT_THRESHOLD = 50 * 1024 * 1024; // 50 MiB (spec-26 Amendment A)
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB — server can override via init response
const MAX_CHUNK_ATTEMPTS = 5;
const RETRY_BACKOFFS_MS = [1000, 2000, 4000, 8000]; // attempts 2..5
/** Per-chunk XHR timeout. Bounded so a half-open TCP through Cloudflare can't
 *  hang the upload forever. 120s comfortably covers an 8 MiB chunk on a 1 Mbps
 *  uplink (~64s) with headroom for tunnel jitter. */
const CHUNK_REQUEST_TIMEOUT_MS = 120_000;

/** Response from a successful POST /upload (HTTP 201). */
export interface UploadResult {
  /** Server-chosen on-disk filename (UUID.ext). Pass this in sendMessage.attachments[].filename. */
  filename: string;
  /** Bytes written to disk (validated server-side). */
  size: number;
  /** Magic-byte-sniffed MIME type. Untrusted client Content-Type is ignored. */
  mime: string;
  /** Echoed display name from X-Filename (may be empty). */
  originalName: string;
}

/** Progress callback payload — fired at most ~10 Hz during upload. */
export interface UploadProgress {
  /** Bytes sent so far. */
  loaded: number;
  /** Total bytes the browser expects to send (matches `size`). */
  total: number;
  /** Convenience: `loaded / total`, clamped to [0, 1]. NaN-safe. */
  ratio: number;
}

export interface UploadOptions {
  /**
   * Optional progress callback. Caller-supplied; errors thrown by it are
   * caught and swallowed so a buggy progress handler can't kill the upload.
   */
  onProgress?: (progress: UploadProgress) => void;
  /**
   * Abort the upload. Once `signal.aborted` is true the in-flight XHR is
   * aborted; the returned promise rejects with `UploadError({ code: "ABORTED" })`.
   * For chunked uploads, a best-effort DELETE /upload/<id> is also fired.
   */
  signal?: AbortSignal;
  /**
   * Optional caller-provided ceiling (bytes). When set, files larger than
   * this are rejected client-side before sending. The runtime still enforces
   * its own ceiling (5 GB hard, server config soft) regardless.
   */
  maxBytes?: number;
  /**
   * Chunked path only: fired when a transient error triggers an automatic
   * retry. `attempt` is the 1-indexed retry count for the current chunk.
   * Used by the text-channels tray to show a "Resuming…" indicator.
   * Errors thrown by it are caught and swallowed.
   */
  onRetry?: (attempt: number) => void;
}

/** Structured upload failure. Mirrors the server's error envelope.
 *
 * Single-shot codes (carried over from POST /upload):
 *   - `ABORTED`, `INVALID_ARGUMENT`, `EMPTY_BODY`, `PAYLOAD_TOO_LARGE`,
 *   - `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`,
 *   - `NETWORK_ERROR`, `TIMEOUT`, `MALFORMED_RESPONSE`, `UPLOAD_FAILED`
 *
 * Chunked path adds:
 *   - `UPLOAD_EXPIRED` — server returned 410 (session TTL elapsed)
 *   - `RANGE_CONFLICT` — repeated 409s the SDK couldn't auto-resync past
 *   - `INTEGRITY_FAILED` — server-side validation failed at finalize
 */
export class UploadError extends Error {
  readonly code: string;
  readonly status: number | null;
  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = "UploadError";
    this.code = code;
    this.status = status;
  }
}

/** Public API surface exposed as `sdk.files`. */
export interface FilesPluginApi {
  /**
   * Upload a file to this plugin's storage area.
   *
   * Returns the server-chosen filename, sniffed MIME, and final size — pass
   * `filename` into `sendMessage.attachments[].filename` to attach it.
   *
   * Throws `UploadError` on any failure. See the `UploadError` doc-comment
   * for the full list of `.code` values.
   */
  upload(file: Blob | File, options?: UploadOptions): Promise<UploadResult>;
}

interface FilesClientDeps {
  /** Bearer token to send in Authorization. */
  token: string;
  /** Plugin slug to send in X-Plugin. */
  slug: string;
  /** Runtime origin to POST to. Injected so tests can stub it. */
  runtimeOrigin: string;
}

/**
 * Build the upload helper bound to a single iframe session. The plugin SDK
 * factory wires this in and exposes it as `sdk.files`.
 */
export function createFilesClient(deps: FilesClientDeps): FilesPluginApi {
  return {
    upload(file, options) {
      return uploadOne(file, options ?? {}, deps);
    },
  };
}

async function uploadOne(
  file: Blob | File,
  options: UploadOptions,
  deps: FilesClientDeps,
): Promise<UploadResult> {
  if (!(file instanceof Blob)) {
    throw new UploadError("INVALID_ARGUMENT", "upload() requires a Blob or File.");
  }
  const size = file.size;
  if (size === 0) {
    throw new UploadError("EMPTY_BODY", "Cannot upload an empty file.");
  }

  const ceiling = options.maxBytes !== undefined
    ? Math.min(options.maxBytes, RUNTIME_HARD_CEILING_BYTES)
    : RUNTIME_HARD_CEILING_BYTES;
  if (size > ceiling) {
    throw new UploadError(
      "PAYLOAD_TOO_LARGE",
      `File exceeds maximum size of ${String(ceiling)} bytes.`,
    );
  }

  const signal = options.signal;
  if (signal?.aborted) {
    throw new UploadError("ABORTED", "Upload aborted before start.");
  }

  if (size <= SINGLE_SHOT_THRESHOLD) {
    return uploadSingleShot(file, options, deps);
  }
  return uploadChunked(file, options, deps);
}

function uploadSingleShot(
  file: Blob | File,
  options: UploadOptions,
  deps: FilesClientDeps,
): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve, reject) => {
    const size = file.size;
    const signal = options.signal;
    // `name` only exists on File, not Blob — extract defensively.
    const originalName = "name" in file && typeof file.name === "string" ? file.name : "";

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${deps.runtimeOrigin}/upload`, true);
    xhr.responseType = "text";

    xhr.setRequestHeader("Authorization", `Bearer ${deps.token}`);
    xhr.setRequestHeader("X-Plugin", deps.slug);
    xhr.setRequestHeader("X-Filename", encodeURIComponent(originalName));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    // The browser sets Content-Length automatically for Blob bodies; we don't
    // (and can't) set it manually — it's a forbidden header in browsers.

    let aborted = false;
    const onAbort = (): void => {
      if (aborted) return;
      aborted = true;
      try { xhr.abort(); } catch { /* xhr already terminal */ }
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const cleanup = (): void => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    if (options.onProgress) {
      const fn = options.onProgress;
      xhr.upload.onprogress = (ev: ProgressEvent): void => {
        const total = ev.lengthComputable && ev.total > 0 ? ev.total : size;
        const loaded = ev.loaded;
        const ratio = total > 0 ? Math.max(0, Math.min(1, loaded / total)) : 0;
        try {
          fn({ loaded, total, ratio });
        } catch {
          // Caller bug — don't let it break the upload.
        }
      };
    }

    xhr.onload = (): void => {
      cleanup();
      if (xhr.status === 201) {
        const parsed = parseUploadResult(xhr.responseText, xhr.status);
        if (parsed.ok) resolve(parsed.result);
        else reject(parsed.error);
        return;
      }
      const { code, message } = parseErrorEnvelope(xhr.responseText, xhr.status);
      reject(new UploadError(code, message, xhr.status));
    };

    xhr.onerror = (): void => {
      cleanup();
      if (aborted) {
        reject(new UploadError("ABORTED", "Upload aborted."));
        return;
      }
      reject(new UploadError("NETWORK_ERROR", "Network error during upload."));
    };

    xhr.onabort = (): void => {
      cleanup();
      reject(new UploadError("ABORTED", "Upload aborted."));
    };

    xhr.ontimeout = (): void => {
      cleanup();
      reject(new UploadError("TIMEOUT", "Upload timed out."));
    };

    xhr.send(file);
  });
}

interface InitResponse {
  upload_id: string;
  chunk_size: number;
  expires_at: number;
  received_bytes: number;
}

interface StatusResponse {
  received_bytes: number;
  total_bytes: number;
  expires_at: number;
}

async function uploadChunked(
  file: Blob | File,
  options: UploadOptions,
  deps: FilesClientDeps,
): Promise<UploadResult> {
  const size = file.size;
  const signal = options.signal;
  const originalName = "name" in file && typeof file.name === "string" ? file.name : "";

  const init = await initSession(originalName, size, options, deps);
  const uploadId = init.upload_id;
  let chunkSize = init.chunk_size > 0 ? init.chunk_size : DEFAULT_CHUNK_SIZE;
  let received = init.received_bytes;

  const onAbort = (): void => {
    // Best-effort cancel; ignore the result. The in-flight chunk XHR is
    // aborted by chunkPatch's own listener.
    void cancelSession(uploadId, deps);
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (received < size) {
      if (signal?.aborted) {
        throw new UploadError("ABORTED", "Upload aborted.");
      }

      const end = Math.min(received + chunkSize, size);
      const chunk = file.slice(received, end);
      const offset = received;

      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          const result = await chunkPatch(uploadId, offset, chunk, size, options, deps);
          received = result.received_bytes;
          if (result.chunk_size > 0) chunkSize = result.chunk_size;
          break;
        } catch (err) {
          if (!(err instanceof UploadError)) throw err;

          // Permanent failures — bail immediately. NOT_FOUND means the upload
          // session is gone (deleted, restart-cleaned, or never existed): no
          // amount of retrying can resurrect it, so surface a clear error
          // instead of spinning on "Resuming…" for the full retry budget.
          if (
            err.code === "ABORTED" ||
            err.code === "UNAUTHORIZED" ||
            err.code === "FORBIDDEN" ||
            err.code === "PAYLOAD_TOO_LARGE" ||
            err.code === "INVALID_ARGUMENT" ||
            err.code === "EMPTY_BODY" ||
            err.code === "INTEGRITY_FAILED" ||
            err.code === "NOT_FOUND"
          ) {
            throw err;
          }
          if (err.code === "UPLOAD_EXPIRED") throw err;

          // 416 RANGE_NOT_SATISFIABLE means the client thinks it has more
          // bytes than the server does — a logic bug, not transient.
          if (err.status === 416) throw err;

          // 409 RANGE_CONFLICT: server received more than we thought.
          // Resync from authoritative status and retry from that offset
          // within the same per-chunk retry budget (a single resync is
          // usually enough; repeated 409s burn the budget and surface).
          if (err.code === "RANGE_CONFLICT" || err.status === 409) {
            attempt++;
            if (attempt >= MAX_CHUNK_ATTEMPTS) {
              throw new UploadError(
                "RANGE_CONFLICT",
                "Upload offset diverged from server and could not be resynced.",
                409,
              );
            }
            const status = await fetchStatus(uploadId, deps).catch(() => null);
            if (status === null) throw err;
            received = status.received_bytes;
            if (received >= size) {
              // Server already has everything — fall through to finalize.
              break;
            }
            fireRetry(options, attempt);
            await sleep(backoffFor(attempt), signal);
            // Restart outer loop to recompute chunk from new offset.
            break;
          }

          // Transient failures (network/timeout/5xx): retry with backoff.
          attempt++;
          if (attempt >= MAX_CHUNK_ATTEMPTS) throw err;
          fireRetry(options, attempt);
          await sleep(backoffFor(attempt), signal);
        }
      }
    }

    if (signal?.aborted) {
      throw new UploadError("ABORTED", "Upload aborted.");
    }

    return await finalizeSession(uploadId, deps);
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

async function initSession(
  originalName: string,
  totalBytes: number,
  options: UploadOptions,
  deps: FilesClientDeps,
): Promise<InitResponse> {
  const res = await jsonRequest(
    "POST",
    `${deps.runtimeOrigin}/upload/init`,
    deps,
    options.signal,
    { original_name: originalName, total_bytes: totalBytes },
  );
  if (res.status !== 200 && res.status !== 201) {
    throw uploadErrorFromResponse(res);
  }
  const parsed = safeJson(res.body);
  if (
    !parsed ||
    typeof parsed["upload_id"] !== "string" ||
    typeof parsed["chunk_size"] !== "number" ||
    typeof parsed["expires_at"] !== "number" ||
    typeof parsed["received_bytes"] !== "number"
  ) {
    throw new UploadError(
      "MALFORMED_RESPONSE",
      "Upload init succeeded but the server response was malformed.",
      res.status,
    );
  }
  return {
    upload_id: parsed["upload_id"],
    chunk_size: parsed["chunk_size"],
    expires_at: parsed["expires_at"],
    received_bytes: parsed["received_bytes"],
  };
}

async function fetchStatus(uploadId: string, deps: FilesClientDeps): Promise<StatusResponse> {
  const res = await jsonRequest("GET", `${deps.runtimeOrigin}/upload/${uploadId}`, deps, undefined, null);
  if (res.status !== 200) throw uploadErrorFromResponse(res);
  const parsed = safeJson(res.body);
  if (
    !parsed ||
    typeof parsed["received_bytes"] !== "number" ||
    typeof parsed["total_bytes"] !== "number" ||
    typeof parsed["expires_at"] !== "number"
  ) {
    throw new UploadError(
      "MALFORMED_RESPONSE",
      "Status response was malformed.",
      res.status,
    );
  }
  return {
    received_bytes: parsed["received_bytes"],
    total_bytes: parsed["total_bytes"],
    expires_at: parsed["expires_at"],
  };
}

async function finalizeSession(uploadId: string, deps: FilesClientDeps): Promise<UploadResult> {
  const res = await jsonRequest(
    "POST",
    `${deps.runtimeOrigin}/upload/${uploadId}/finalize`,
    deps,
    undefined,
    {},
  );
  if (res.status !== 201) throw uploadErrorFromResponse(res);
  const parsed = parseUploadResult(res.body, res.status);
  if (parsed.ok) return parsed.result;
  throw parsed.error;
}

async function cancelSession(uploadId: string, deps: FilesClientDeps): Promise<void> {
  // Fire-and-forget — failure to delete doesn't propagate; the server GC
  // will reap orphaned sessions after the 24h TTL.
  try {
    await jsonRequest("DELETE", `${deps.runtimeOrigin}/upload/${uploadId}`, deps, undefined, null);
  } catch {
    /* swallow */
  }
}

interface ChunkPatchResult {
  received_bytes: number;
  chunk_size: number;
}

function chunkPatch(
  uploadId: string,
  offset: number,
  chunk: Blob,
  totalBytes: number,
  options: UploadOptions,
  deps: FilesClientDeps,
): Promise<ChunkPatchResult> {
  return new Promise<ChunkPatchResult>((resolve, reject) => {
    const signal = options.signal;
    const chunkSize = chunk.size;

    const xhr = new XMLHttpRequest();
    xhr.open("PATCH", `${deps.runtimeOrigin}/upload/${uploadId}?offset=${String(offset)}`, true);
    xhr.responseType = "text";
    xhr.timeout = CHUNK_REQUEST_TIMEOUT_MS;
    xhr.setRequestHeader("Authorization", `Bearer ${deps.token}`);
    xhr.setRequestHeader("X-Plugin", deps.slug);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    let aborted = false;
    const onAbort = (): void => {
      if (aborted) return;
      aborted = true;
      try { xhr.abort(); } catch { /* xhr already terminal */ }
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const cleanup = (): void => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    if (options.onProgress) {
      const fn = options.onProgress;
      xhr.upload.onprogress = (ev: ProgressEvent): void => {
        // Chunk size is known (we sliced it), so lengthComputable is moot —
        // just clamp ev.loaded to the chunk size in case the browser reports
        // a value past the upload's true end.
        const chunkLoaded = Math.min(ev.loaded, chunkSize);
        const loaded = Math.min(offset + chunkLoaded, totalBytes);
        const ratio = totalBytes > 0 ? Math.max(0, Math.min(1, loaded / totalBytes)) : 0;
        try {
          fn({ loaded, total: totalBytes, ratio });
        } catch {
          // Caller bug — don't let it break the upload.
        }
      };
    }

    xhr.onload = (): void => {
      cleanup();
      if (xhr.status === 200) {
        const parsed = safeJson(xhr.responseText);
        if (
          !parsed ||
          typeof parsed["received_bytes"] !== "number"
        ) {
          reject(new UploadError(
            "MALFORMED_RESPONSE",
            "PATCH succeeded but the server response was malformed.",
            xhr.status,
          ));
          return;
        }
        const cs = typeof parsed["chunk_size"] === "number" ? parsed["chunk_size"] : 0;
        resolve({ received_bytes: parsed["received_bytes"], chunk_size: cs });
        return;
      }
      const { code, message } = parseErrorEnvelope(xhr.responseText, xhr.status);
      reject(new UploadError(code, message, xhr.status));
    };

    xhr.onerror = (): void => {
      cleanup();
      if (aborted) {
        reject(new UploadError("ABORTED", "Upload aborted."));
        return;
      }
      reject(new UploadError("NETWORK_ERROR", "Network error during chunk upload."));
    };

    xhr.onabort = (): void => {
      cleanup();
      reject(new UploadError("ABORTED", "Upload aborted."));
    };

    xhr.ontimeout = (): void => {
      cleanup();
      reject(new UploadError("TIMEOUT", "Chunk upload timed out."));
    };

    xhr.send(chunk);
  });
}

interface JsonResponse {
  status: number;
  body: string;
}

function jsonRequest(
  method: string,
  url: string,
  deps: FilesClientDeps,
  signal: AbortSignal | undefined,
  body: Record<string, unknown> | null,
): Promise<JsonResponse> {
  return new Promise<JsonResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.responseType = "text";
    xhr.setRequestHeader("Authorization", `Bearer ${deps.token}`);
    xhr.setRequestHeader("X-Plugin", deps.slug);
    if (body !== null) xhr.setRequestHeader("Content-Type", "application/json");

    let aborted = false;
    const onAbort = (): void => {
      if (aborted) return;
      aborted = true;
      try { xhr.abort(); } catch { /* xhr already terminal */ }
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const cleanup = (): void => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    xhr.onload = (): void => {
      cleanup();
      resolve({ status: xhr.status, body: xhr.responseText });
    };
    xhr.onerror = (): void => {
      cleanup();
      if (aborted) reject(new UploadError("ABORTED", "Upload aborted."));
      else reject(new UploadError("NETWORK_ERROR", `Network error during ${method}.`));
    };
    xhr.onabort = (): void => {
      cleanup();
      reject(new UploadError("ABORTED", "Upload aborted."));
    };
    xhr.ontimeout = (): void => {
      cleanup();
      reject(new UploadError("TIMEOUT", `${method} timed out.`));
    };

    xhr.send(body === null ? null : JSON.stringify(body));
  });
}

function uploadErrorFromResponse(res: JsonResponse): UploadError {
  const { code, message } = parseErrorEnvelope(res.body, res.status);
  return new UploadError(code, message, res.status);
}

function safeJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function parseUploadResult(
  responseText: string,
  status: number,
): { ok: true; result: UploadResult } | { ok: false; error: UploadError } {
  try {
    const parsed = JSON.parse(responseText) as Record<string, unknown>;
    if (
      parsed["ok"] === true &&
      typeof parsed["filename"] === "string" &&
      typeof parsed["size"] === "number" &&
      typeof parsed["mime"] === "string"
    ) {
      return {
        ok: true,
        result: {
          filename: parsed["filename"],
          size: parsed["size"],
          mime: parsed["mime"],
          originalName: typeof parsed["originalName"] === "string" ? parsed["originalName"] : "",
        },
      };
    }
    return {
      ok: false,
      error: new UploadError(
        "MALFORMED_RESPONSE",
        "Upload succeeded but the server response was malformed.",
        status,
      ),
    };
  } catch {
    return {
      ok: false,
      error: new UploadError(
        "MALFORMED_RESPONSE",
        "Upload succeeded but the server response was not JSON.",
        status,
      ),
    };
  }
}

function fireRetry(options: UploadOptions, attempt: number): void {
  if (!options.onRetry) return;
  try {
    options.onRetry(attempt);
  } catch {
    // Caller bug — don't let it break the upload.
  }
}

function backoffFor(attempt: number): number {
  // attempt is 1-indexed retry count; backoff index is attempt-1, capped.
  const idx = Math.min(attempt - 1, RETRY_BACKOFFS_MS.length - 1);
  return RETRY_BACKOFFS_MS[idx] ?? 8000;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadError("ABORTED", "Upload aborted."));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new UploadError("ABORTED", "Upload aborted."));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseErrorEnvelope(
  responseText: string,
  status: number,
): { code: string; message: string } {
  // Map common HTTP statuses when the body isn't a parseable envelope.
  const fallback = (): { code: string; message: string } => {
    if (status === 401) return { code: "UNAUTHORIZED", message: "Authentication failed." };
    if (status === 403) return { code: "FORBIDDEN", message: "Permission denied." };
    if (status === 404) return { code: "NOT_FOUND", message: "Upload session not found." };
    if (status === 409) return { code: "RANGE_CONFLICT", message: "Offset conflicts with server state." };
    if (status === 410) return { code: "UPLOAD_EXPIRED", message: "Upload session has expired." };
    if (status === 413) return { code: "PAYLOAD_TOO_LARGE", message: "File too large." };
    if (status === 416) return { code: "RANGE_NOT_SATISFIABLE", message: "Offset is beyond received bytes." };
    if (status === 422) return { code: "INTEGRITY_FAILED", message: "Upload failed integrity check." };
    if (status === 429) return { code: "RATE_LIMITED", message: "Too many uploads." };
    return { code: "UPLOAD_FAILED", message: `Upload failed (HTTP ${String(status)}).` };
  };

  if (!responseText) return fallback();
  try {
    const parsed = JSON.parse(responseText) as Record<string, unknown>;
    const err = parsed["error"];
    if (err && typeof err === "object") {
      const errObj = err as Record<string, unknown>;
      const code = typeof errObj["code"] === "string" ? errObj["code"] : fallback().code;
      const message = typeof errObj["message"] === "string"
        ? errObj["message"]
        : fallback().message;
      return { code, message };
    }
  } catch {
    // fall through
  }
  return fallback();
}
