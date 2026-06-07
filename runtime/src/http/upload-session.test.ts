import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createHttpHandler, type HttpHandlerHandle } from "./handler";
import {
  CHUNK_SIZE,
  HARD_UPLOAD_CEILING,
  SESSION_TTL_MS,
  sweepStaleUploadSessions,
  type UploadSessionMeta,
} from "./upload-session";
import type {
  HttpDependencies,
  PluginInfo,
  PluginRegistry,
  ServerConfig,
  FileUploadNotification,
} from "./types";
import { defaultUpdateState } from "../update-state/types";
import type {
  TokenValidator,
  AuthenticatedUser,
  TokenValidationResult,
} from "../ws/types";
import type { RolesEngine } from "../roles/engine";
import type { PluginManifest } from "@uncorded/shared";

// ---------------------------------------------------------------------------
// Mocks (mirrors handler.test.ts harness pattern)
// ---------------------------------------------------------------------------

function mockManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return {
    name: "test-plugin",
    version: "1.0.0",
    api_version: "^1.0",
    author: "Test",
    description: "Test plugin",
    type: "standalone",
    permissions: ["storage.file:self"],
    ...overrides,
  };
}

function mockPluginRegistry(plugins: PluginInfo[]): PluginRegistry {
  const map = new Map(plugins.map((p) => [p.slug, p]));
  return {
    getPlugin: (slug) => map.get(slug),
    getPluginCount: () => map.size,
    listPlugins: () => [...map.values()],
    setReady(slug, ready) {
      const existing = map.get(slug);
      if (existing === undefined) return;
      map.set(slug, { ...existing, ready });
    },
  };
}

function mockTokenValidator(
  tokens: Map<string, AuthenticatedUser>,
): TokenValidator {
  return {
    async validate(token: string): Promise<TokenValidationResult> {
      const user = tokens.get(token);
      if (user) return { ok: true, user };
      return { ok: false, code: "INVALID_TOKEN", message: "invalid" };
    },
  };
}

const ALICE: AuthenticatedUser = {
  id: "alice-1",
  username: "alice",
  displayName: "Alice",
  avatarUrl: "",
  role: "member",
};
const BOB: AuthenticatedUser = {
  id: "bob-1",
  username: "bob",
  displayName: "Bob",
  avatarUrl: "",
  role: "member",
};

const TOKENS = new Map<string, AuthenticatedUser>([
  ["alice-token", ALICE],
  ["bob-token", BOB],
]);

function mockRolesEngine(): RolesEngine {
  return {
    hasMinLevel: () => true,
    check: () => true,
    getRole: () => ({
      id: 4,
      name: "member",
      level: 10,
      isDefault: true,
      parentRole: null,
      createdAt: 0,
      updatedAt: 0,
    }),
  } as unknown as RolesEngine;
}

function defaultConfig(): ServerConfig {
  return {
    isPrivate: false,
    maxUploadBytes: 5 * 1024 * 1024 * 1024, // 5 GiB — match prod default
    startedAt: Date.now() - 60_000,
    serverName: "Test Server",
    serverDescription: "",
  };
}

interface TestContext {
  handler: HttpHandlerHandle;
  server: ReturnType<typeof Bun.serve>;
  baseUrl: string;
  notifications: Array<{ slug: string; notification: FileUploadNotification }>;
  tmpDir: string;
  pluginDir: string;
  coreDb: Database;
  registry: PluginRegistry;
}

function createCtx(opts?: {
  configOverrides?: Partial<ServerConfig>;
  permissions?: string[];
  slug?: string;
}): TestContext {
  const slug = opts?.slug ?? "gallery";
  const tmpDir = join(tmpdir(), `uncorded-upsess-${crypto.randomUUID()}`);
  const pluginDir = join(tmpDir, "plugin-data");
  mkdirSync(pluginDir, { recursive: true });

  const plugin: PluginInfo = {
    slug,
    manifest: mockManifest({
      name: slug,
      permissions: opts?.permissions ?? ["storage.file:self"],
    }),
    dataDir: pluginDir,
    frontendDir: null,
    authenticatedAssets: false,
    ready: true,
  };
  const registry = mockPluginRegistry([plugin]);

  const notifications: TestContext["notifications"] = [];
  const coreDb = new Database(":memory:");

  const deps: HttpDependencies = {
    tokenValidator: mockTokenValidator(TOKENS),
    rolesEngine: mockRolesEngine(),
    coreModule: null as unknown as import("../core").CoreModule,
    coreDb,
    pluginRegistry: registry,
    getInstalledPlugins: () => [{ slug, manifest: plugin.manifest }],
    getPluginRuntimeState: () => undefined,
    getPluginLogs: () => [],
    stopPlugin: () => Promise.resolve(),
    config: { ...defaultConfig(), ...opts?.configOverrides },
    notifyPlugin: (s, n) => notifications.push({ slug: s, notification: n }),
    getPluginProcess: () => undefined,
    getPluginDb: () => {
      throw new Error("not stubbed");
    },
    getClientIp: () => "127.0.0.1",
    broadcastEventToUser: () => {},
    broadcastEvent: () => {},
    areKeysStale: () => false,
    allowedOrigins: [],
    runtimeVersion: "1.0.0-test",
    getUpdateState: () => defaultUpdateState("1.0.0-test", 0),
    setUpdateState: (patch) => ({
      ...defaultUpdateState("1.0.0-test", 0),
      ...patch,
      updatedAt: 0,
    }),
    getUpdateLog: () => [],
  };

  const handler = createHttpHandler({ deps });
  const server = Bun.serve({ port: 0, fetch: handler.fetch });

  return {
    handler,
    server,
    baseUrl: `http://localhost:${server.port}`,
    notifications,
    tmpDir,
    pluginDir,
    coreDb,
    registry,
  };
}

let ctx: TestContext;

afterEach(() => {
  ctx.handler.dispose();
  ctx.server.stop(true);
  ctx.coreDb.close();
  try {
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// Helper: kick off a session and return upload_id + chunk_size
// ---------------------------------------------------------------------------

async function initSession(
  baseUrl: string,
  totalBytes: number,
  opts?: { token?: string; slug?: string; originalName?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/upload/init`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts?.token ?? "alice-token"}`,
      "X-Plugin": opts?.slug ?? "gallery",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      total_bytes: totalBytes,
      original_name: opts?.originalName ?? "test.bin",
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

async function patchChunk(
  baseUrl: string,
  uploadId: string,
  offset: number,
  data: Uint8Array,
  opts?: { token?: string; slug?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(
    `${baseUrl}/upload/${uploadId}?offset=${offset}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${opts?.token ?? "alice-token"}`,
        "X-Plugin": opts?.slug ?? "gallery",
        "Content-Type": "application/octet-stream",
        "Content-Length": String(data.byteLength),
      },
      body: data as BodyInit,
    },
  );
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

async function finalize(
  baseUrl: string,
  uploadId: string,
  opts?: { token?: string; slug?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/upload/${uploadId}/finalize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts?.token ?? "alice-token"}`,
      "X-Plugin": opts?.slug ?? "gallery",
    },
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// POST /upload/init
// ---------------------------------------------------------------------------

describe("POST /upload/init", () => {
  test("returns 401 without auth", async () => {
    ctx = createCtx();
    const res = await fetch(`${ctx.baseUrl}/upload/init`, {
      method: "POST",
      headers: { "X-Plugin": "gallery", "Content-Type": "application/json" },
      body: JSON.stringify({ total_bytes: 1024 }),
    });
    expect(res.status).toBe(401);
  });

  test("returns 400 without X-Plugin", async () => {
    ctx = createCtx();
    const res = await fetch(`${ctx.baseUrl}/upload/init`, {
      method: "POST",
      headers: {
        Authorization: "Bearer alice-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ total_bytes: 1024 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MISSING_PLUGIN_HEADER");
  });

  test("returns 403 when plugin lacks storage.file:self", async () => {
    ctx = createCtx({ permissions: ["data.sql:self"] });
    const { status, body } = await initSession(ctx.baseUrl, 1024);
    expect(status).toBe(403);
    expect((body as { error: { code: string } }).error.code).toBeTruthy();
  });

  test("returns 413 when total_bytes exceeds ceiling", async () => {
    ctx = createCtx({ configOverrides: { maxUploadBytes: 1024 } });
    const { status, body } = await initSession(ctx.baseUrl, 4096);
    expect(status).toBe(413);
    expect((body as { error: { code: string } }).error.code).toBe(
      "PAYLOAD_TOO_LARGE",
    );
  });

  test("returns 400 for total_bytes=0", async () => {
    ctx = createCtx();
    const { status, body } = await initSession(ctx.baseUrl, 0);
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("EMPTY_BODY");
  });

  test("happy path returns upload_id, chunk_size, expires_at", async () => {
    ctx = createCtx();
    const { status, body } = await initSession(ctx.baseUrl, 1024);
    expect(status).toBe(201);
    const b = body as {
      ok: boolean;
      upload_id: string;
      chunk_size: number;
      total_bytes: number;
      received_bytes: number;
      expires_at: number;
    };
    expect(b.ok).toBe(true);
    expect(b.upload_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.chunk_size).toBe(CHUNK_SIZE);
    expect(b.total_bytes).toBe(1024);
    expect(b.received_bytes).toBe(0);
    expect(b.expires_at).toBeGreaterThan(Date.now());
    // Session dir + meta.json now exist on disk.
    const sessionDir = join(
      ctx.pluginDir,
      "uploads.in_progress",
      b.upload_id,
    );
    const meta = JSON.parse(
      readFileSync(join(sessionDir, "meta.json"), "utf8"),
    ) as UploadSessionMeta;
    expect(meta.user_id).toBe("alice-1");
    expect(meta.plugin_slug).toBe("gallery");
    expect(meta.total_bytes).toBe(1024);
    expect(meta.received_bytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PATCH /upload/<id>
// ---------------------------------------------------------------------------

describe("PATCH /upload/<id>", () => {
  test("appends a chunk and advances received_bytes", async () => {
    ctx = createCtx();
    const { body: init } = await initSession(ctx.baseUrl, 16);
    const uploadId = (init as { upload_id: string }).upload_id;

    const chunk = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { status, body } = await patchChunk(ctx.baseUrl, uploadId, 0, chunk);
    expect(status).toBe(200);
    expect((body as { received_bytes: number }).received_bytes).toBe(8);
  });

  test("multi-chunk happy path → finalize → file lands in uploads/", async () => {
    ctx = createCtx();
    // PNG magic + filler so the sniffer recognizes image/png at finalize.
    const total = 24;
    const chunk1 = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const chunk2 = new Uint8Array(8).fill(0xaa);
    const chunk3 = new Uint8Array(8).fill(0xbb);

    const { body: init } = await initSession(ctx.baseUrl, total);
    const uploadId = (init as { upload_id: string }).upload_id;

    const r1 = await patchChunk(ctx.baseUrl, uploadId, 0, chunk1);
    expect(r1.status).toBe(200);
    expect((r1.body as { received_bytes: number }).received_bytes).toBe(8);
    const r2 = await patchChunk(ctx.baseUrl, uploadId, 8, chunk2);
    expect(r2.status).toBe(200);
    expect((r2.body as { received_bytes: number }).received_bytes).toBe(16);
    const r3 = await patchChunk(ctx.baseUrl, uploadId, 16, chunk3);
    expect(r3.status).toBe(200);
    expect((r3.body as { received_bytes: number }).received_bytes).toBe(24);

    const fin = await finalize(ctx.baseUrl, uploadId);
    expect(fin.status).toBe(201);
    const f = fin.body as {
      ok: boolean;
      filename: string;
      size: number;
      mime: string;
    };
    expect(f.ok).toBe(true);
    expect(f.mime).toBe("image/png");
    expect(f.filename).toMatch(/^[0-9a-f-]+\.png$/);
    expect(f.size).toBe(24);

    // Final file exists, session dir is gone.
    expect(
      Bun.file(join(ctx.pluginDir, "uploads", f.filename)).size,
    ).toBe(24);

    // Notification fired.
    expect(ctx.notifications).toHaveLength(1);
    expect(ctx.notifications[0]!.notification.uploadedBy).toBe("alice-1");
  });

  test("409 RANGE_CONFLICT when offset is behind server state", async () => {
    ctx = createCtx();
    const { body: init } = await initSession(ctx.baseUrl, 16);
    const uploadId = (init as { upload_id: string }).upload_id;

    await patchChunk(ctx.baseUrl, uploadId, 0, new Uint8Array(8).fill(1));
    // Now received_bytes is 8 — re-sending at offset 0 must conflict.
    const r = await patchChunk(ctx.baseUrl, uploadId, 0, new Uint8Array(8).fill(2));
    expect(r.status).toBe(409);
    const err = r.body as { error: { code: string; received_bytes: number } };
    expect(err.error.code).toBe("RANGE_CONFLICT");
    expect(err.error.received_bytes).toBe(8);
  });

  test("416 RANGE_NOT_SATISFIABLE when offset is ahead of server state", async () => {
    ctx = createCtx();
    const { body: init } = await initSession(ctx.baseUrl, 16);
    const uploadId = (init as { upload_id: string }).upload_id;
    // Server is at received_bytes=0 — sending at offset=4 leaves a gap.
    const r = await patchChunk(ctx.baseUrl, uploadId, 4, new Uint8Array(4));
    expect(r.status).toBe(416);
    const err = r.body as { error: { code: string } };
    expect(err.error.code).toBe("RANGE_NOT_SATISFIABLE");
  });

  test("403 when a different user tries to PATCH", async () => {
    ctx = createCtx();
    const { body: init } = await initSession(ctx.baseUrl, 16, { token: "alice-token" });
    const uploadId = (init as { upload_id: string }).upload_id;
    const r = await patchChunk(
      ctx.baseUrl,
      uploadId,
      0,
      new Uint8Array(8),
      { token: "bob-token" },
    );
    expect(r.status).toBe(403);
    expect((r.body as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });

  test("404 for unknown upload_id (UUID-shaped but unallocated)", async () => {
    ctx = createCtx();
    const fakeId = crypto.randomUUID();
    const r = await patchChunk(ctx.baseUrl, fakeId, 0, new Uint8Array(8));
    expect(r.status).toBe(404);
  });

  test("413 when chunk exceeds CHUNK_SIZE", async () => {
    ctx = createCtx();
    const { body: init } = await initSession(
      ctx.baseUrl,
      CHUNK_SIZE + 1024 * 1024,
    );
    const uploadId = (init as { upload_id: string }).upload_id;
    // Send a real >CHUNK_SIZE buffer; fetch sets Content-Length from it
    // and the handler rejects pre-stream on the size check.
    const tooBig = new Uint8Array(CHUNK_SIZE + 1);
    const res = await fetch(`${ctx.baseUrl}/upload/${uploadId}?offset=0`, {
      method: "PATCH",
      headers: {
        Authorization: "Bearer alice-token",
        "X-Plugin": "gallery",
        "Content-Type": "application/octet-stream",
      },
      body: tooBig as BodyInit,
    });
    expect(res.status).toBe(413);
  });

  test("400 LENGTH_MISMATCH when declared > remaining", async () => {
    ctx = createCtx();
    const { body: init } = await initSession(ctx.baseUrl, 4);
    const uploadId = (init as { upload_id: string }).upload_id;
    const r = await patchChunk(ctx.baseUrl, uploadId, 0, new Uint8Array(8));
    expect(r.status).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe(
      "LENGTH_MISMATCH",
    );
  });
});

// ---------------------------------------------------------------------------
// GET /upload/<id>
// ---------------------------------------------------------------------------

describe("GET /upload/<id>", () => {
  test("returns received_bytes for resume", async () => {
    ctx = createCtx();
    const { body: init } = await initSession(ctx.baseUrl, 16);
    const uploadId = (init as { upload_id: string }).upload_id;
    await patchChunk(ctx.baseUrl, uploadId, 0, new Uint8Array(10));
    const res = await fetch(`${ctx.baseUrl}/upload/${uploadId}`, {
      headers: { Authorization: "Bearer alice-token", "X-Plugin": "gallery" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      received_bytes: number;
      total_bytes: number;
    };
    expect(body.received_bytes).toBe(10);
    expect(body.total_bytes).toBe(16);
  });

  test("403 for cross-user status read", async () => {
    ctx = createCtx();
    const { body: init } = await initSession(ctx.baseUrl, 16);
    const uploadId = (init as { upload_id: string }).upload_id;
    const res = await fetch(`${ctx.baseUrl}/upload/${uploadId}`, {
      headers: { Authorization: "Bearer bob-token", "X-Plugin": "gallery" },
    });
    expect(res.status).toBe(403);
  });

  test("410 UPLOAD_EXPIRED when session expires_at is in the past", async () => {
    ctx = createCtx();
    const { body: init } = await initSession(ctx.baseUrl, 16);
    const uploadId = (init as { upload_id: string }).upload_id;
    // Backdate meta.json by hand.
    const metaFile = join(
      ctx.pluginDir,
      "uploads.in_progress",
      uploadId,
      "meta.json",
    );
    const meta = JSON.parse(readFileSync(metaFile, "utf8")) as UploadSessionMeta;
    meta.expires_at = Date.now() - 1000;
    writeFileSync(metaFile, JSON.stringify(meta));

    const res = await fetch(`${ctx.baseUrl}/upload/${uploadId}`, {
      headers: { Authorization: "Bearer alice-token", "X-Plugin": "gallery" },
    });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UPLOAD_EXPIRED");
  });
});

// ---------------------------------------------------------------------------
// POST /upload/<id>/finalize
// ---------------------------------------------------------------------------

describe("POST /upload/<id>/finalize", () => {
  test("409 INCOMPLETE_UPLOAD when received < total", async () => {
    ctx = createCtx();
    const { body: init } = await initSession(ctx.baseUrl, 16);
    const uploadId = (init as { upload_id: string }).upload_id;
    await patchChunk(ctx.baseUrl, uploadId, 0, new Uint8Array(8));
    const fin = await finalize(ctx.baseUrl, uploadId);
    expect(fin.status).toBe(409);
    expect((fin.body as { error: { code: string } }).error.code).toBe(
      "INCOMPLETE_UPLOAD",
    );
  });

  test("422 INTEGRITY_FAILED when on-disk size != meta.total_bytes", async () => {
    ctx = createCtx();
    const { body: init } = await initSession(ctx.baseUrl, 16);
    const uploadId = (init as { upload_id: string }).upload_id;
    // Fake out the meta — claim 16 bytes received but only 8 on disk.
    await patchChunk(ctx.baseUrl, uploadId, 0, new Uint8Array(8));
    const metaFile = join(
      ctx.pluginDir,
      "uploads.in_progress",
      uploadId,
      "meta.json",
    );
    const meta = JSON.parse(readFileSync(metaFile, "utf8")) as UploadSessionMeta;
    meta.received_bytes = meta.total_bytes; // claim complete
    writeFileSync(metaFile, JSON.stringify(meta));

    const fin = await finalize(ctx.baseUrl, uploadId);
    expect(fin.status).toBe(422);
    expect((fin.body as { error: { code: string } }).error.code).toBe(
      "INTEGRITY_FAILED",
    );
  });

  test("403 when another user finalizes", async () => {
    ctx = createCtx();
    const { body: init } = await initSession(ctx.baseUrl, 8);
    const uploadId = (init as { upload_id: string }).upload_id;
    await patchChunk(ctx.baseUrl, uploadId, 0, new Uint8Array(8));
    const fin = await finalize(ctx.baseUrl, uploadId, { token: "bob-token" });
    expect(fin.status).toBe(403);
  });

  test("sniffed MIME comes from saved head bytes, not the client", async () => {
    ctx = createCtx();
    // PDF magic bytes — sniffer should detect application/pdf regardless of
    // any client-supplied Content-Type on the chunk.
    const pdfHead = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    const rest = new Uint8Array(11).fill(0);
    const data = new Uint8Array(16);
    data.set(pdfHead, 0);
    data.set(rest, pdfHead.length);

    const { body: init } = await initSession(ctx.baseUrl, 16);
    const uploadId = (init as { upload_id: string }).upload_id;
    await patchChunk(ctx.baseUrl, uploadId, 0, data);
    const fin = await finalize(ctx.baseUrl, uploadId);
    expect(fin.status).toBe(201);
    expect((fin.body as { mime: string }).mime).toBe("application/pdf");
  });
});

// ---------------------------------------------------------------------------
// DELETE /upload/<id>
// ---------------------------------------------------------------------------

describe("DELETE /upload/<id>", () => {
  test("removes the session dir", async () => {
    ctx = createCtx();
    const { body: init } = await initSession(ctx.baseUrl, 16);
    const uploadId = (init as { upload_id: string }).upload_id;
    await patchChunk(ctx.baseUrl, uploadId, 0, new Uint8Array(8));

    const sessionDir = join(
      ctx.pluginDir,
      "uploads.in_progress",
      uploadId,
    );
    expect(Bun.file(join(sessionDir, "meta.json")).size).toBeGreaterThan(0);

    const res = await fetch(`${ctx.baseUrl}/upload/${uploadId}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer alice-token", "X-Plugin": "gallery" },
    });
    expect(res.status).toBe(200);
    expect(await Bun.file(join(sessionDir, "meta.json")).exists()).toBe(false);
  });

  test("idempotent — second DELETE returns 200 with deleted:false", async () => {
    ctx = createCtx();
    const fakeId = crypto.randomUUID();
    const res = await fetch(`${ctx.baseUrl}/upload/${fakeId}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer alice-token", "X-Plugin": "gallery" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean };
    expect(body.deleted).toBe(false);
  });

  test("403 when a different user tries to cancel", async () => {
    ctx = createCtx();
    const { body: init } = await initSession(ctx.baseUrl, 16);
    const uploadId = (init as { upload_id: string }).upload_id;
    const res = await fetch(`${ctx.baseUrl}/upload/${uploadId}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer bob-token", "X-Plugin": "gallery" },
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Resume semantics — disconnect mid-chunk, GET, retry at correct offset
// ---------------------------------------------------------------------------

describe("resume semantics", () => {
  test("status → retry from received_bytes succeeds", async () => {
    ctx = createCtx();
    const { body: init } = await initSession(ctx.baseUrl, 24);
    const uploadId = (init as { upload_id: string }).upload_id;

    await patchChunk(ctx.baseUrl, uploadId, 0, new Uint8Array(8).fill(1));
    // Simulate a client that "lost" its in-memory state and queries status.
    const statusRes = await fetch(`${ctx.baseUrl}/upload/${uploadId}`, {
      headers: { Authorization: "Bearer alice-token", "X-Plugin": "gallery" },
    });
    const status = (await statusRes.json()) as { received_bytes: number };
    expect(status.received_bytes).toBe(8);

    // Resume at the authoritative offset.
    const r2 = await patchChunk(
      ctx.baseUrl,
      uploadId,
      status.received_bytes,
      new Uint8Array(8).fill(2),
    );
    expect(r2.status).toBe(200);
    expect((r2.body as { received_bytes: number }).received_bytes).toBe(16);
    const r3 = await patchChunk(ctx.baseUrl, uploadId, 16, new Uint8Array(8).fill(3));
    expect(r3.status).toBe(200);
    const fin = await finalize(ctx.baseUrl, uploadId);
    expect(fin.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Concurrent PATCH mutex — second caller sees the first caller's append
// ---------------------------------------------------------------------------

describe("concurrent PATCH mutex", () => {
  test("racing PATCHes serialize: one succeeds, the other gets 409 or appends sequentially", async () => {
    ctx = createCtx();
    const { body: init } = await initSession(ctx.baseUrl, 16);
    const uploadId = (init as { upload_id: string }).upload_id;

    const [a, b] = await Promise.all([
      patchChunk(ctx.baseUrl, uploadId, 0, new Uint8Array(8).fill(1)),
      patchChunk(ctx.baseUrl, uploadId, 0, new Uint8Array(8).fill(2)),
    ]);
    // Exactly one must have hit the lock first and won. The other must
    // observe the post-write state — either a 409 RANGE_CONFLICT (offset 0
    // is now behind received_bytes=8) or the same 200 if Bun delivered
    // them serially and both saw an advancing state.
    const codes = [a.status, b.status].sort();
    expect(codes[0]).toBe(200);
    const second = codes[1];
    expect(second === 200 || second === 409).toBe(true);

    // After whichever succeeded, status should be deterministic at 8.
    const statusRes = await fetch(`${ctx.baseUrl}/upload/${uploadId}`, {
      headers: { Authorization: "Bearer alice-token", "X-Plugin": "gallery" },
    });
    const status = (await statusRes.json()) as { received_bytes: number };
    expect(status.received_bytes).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// sweepStaleUploadSessions
// ---------------------------------------------------------------------------

describe("sweepStaleUploadSessions", () => {
  test("removes expired sessions, keeps live ones", async () => {
    ctx = createCtx();
    const { body: alive } = await initSession(ctx.baseUrl, 16);
    const { body: doomed } = await initSession(ctx.baseUrl, 16);
    const aliveId = (alive as { upload_id: string }).upload_id;
    const doomedId = (doomed as { upload_id: string }).upload_id;

    // Backdate the doomed session's expires_at.
    const metaFile = join(
      ctx.pluginDir,
      "uploads.in_progress",
      doomedId,
      "meta.json",
    );
    const meta = JSON.parse(readFileSync(metaFile, "utf8")) as UploadSessionMeta;
    meta.expires_at = Date.now() - SESSION_TTL_MS;
    writeFileSync(metaFile, JSON.stringify(meta));

    const result = await sweepStaleUploadSessions(ctx.registry);
    expect(result.scanned).toBe(2);
    expect(result.removed).toBe(1);

    expect(
      await Bun.file(
        join(ctx.pluginDir, "uploads.in_progress", aliveId, "meta.json"),
      ).exists(),
    ).toBe(true);
    expect(
      await Bun.file(
        join(ctx.pluginDir, "uploads.in_progress", doomedId, "meta.json"),
      ).exists(),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HARD_UPLOAD_CEILING is the 5 GiB documented in spec-26 Amendment A
// ---------------------------------------------------------------------------

describe("locked constants", () => {
  test("HARD_UPLOAD_CEILING is 5 GiB", () => {
    expect(HARD_UPLOAD_CEILING).toBe(5 * 1024 * 1024 * 1024);
  });
  test("CHUNK_SIZE is 8 MiB", () => {
    expect(CHUNK_SIZE).toBe(8 * 1024 * 1024);
  });
  test("SESSION_TTL_MS is 24h", () => {
    expect(SESSION_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});
