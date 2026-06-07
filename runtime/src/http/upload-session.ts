// Chunked + resumable upload protocol — spec-26 Amendment A.
//
// Endpoint family:
//   POST   /upload/init                  → reserve upload_id, return chunk_size + TTL
//   PATCH  /upload/<id>?offset=N         → append one chunk at byte N
//   GET    /upload/<id>                  → status (received_bytes, total_bytes, expires_at)
//   POST   /upload/<id>/finalize         → sniff MIME, atomic-rename, notify plugin
//   DELETE /upload/<id>                  → cancel + delete partial
//
// Storage:
//   <plugin.dataDir>/uploads.in_progress/<upload_id>/{data, meta.json}
//
// Meta writes are atomic (write to .tmp, fsync, rename). Per-upload_id mutex
// serializes concurrent PATCH/finalize/cancel calls (same pattern as
// openConnection's in-flight dedup map). user_id + plugin_slug are pinned at
// init and re-checked on every subsequent op — survives token refresh, blocks
// cross-user takeover.

import { join } from "node:path";
import {
  mkdir,
  rename,
  readdir,
  stat,
  rm,
  open as fsOpen,
  readFile,
  writeFile,
} from "node:fs/promises";
import { CapabilityChecker } from "../capabilities/checker";
import { sniffMime, extensionForMime } from "./mime-sniff";
import { extractAuth } from "./auth";
import type { RateLimiter } from "./rate-limiter";
import { RATE_UPLOAD, RATE_UPLOAD_CHUNK } from "./rate-limiter";
import type {
  HttpDependencies,
  FileUploadNotification,
  PluginRegistry,
  PluginInfo,
} from "./types";
import { rootLogger } from "@uncorded/shared";

const log = rootLogger.child({ component: "http", surface: "upload-session" });

// ---------------------------------------------------------------------------
// Locked numbers (spec-26 Amendment A)
// ---------------------------------------------------------------------------

/** 5 GiB absolute ceiling — spec-26 Amendment A. */
export const HARD_UPLOAD_CEILING = 5 * 1024 * 1024 * 1024;

/** Server-recommended chunk size, returned by /upload/init. 8 MiB. */
export const CHUNK_SIZE = 8 * 1024 * 1024;

/** Session TTL — extended on every PATCH. 24h. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** GC sweep interval — re-runs the stale-session walk. 60 min. */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Persistent metadata shape
// ---------------------------------------------------------------------------

export interface UploadSessionMeta {
  upload_id: string;
  plugin_slug: string;
  user_id: string;
  original_name: string;
  total_bytes: number;
  received_bytes: number;
  /** Base64-encoded first up-to-64 bytes — used by finalize() to sniff MIME. */
  head_b64: string;
  created_at: number;
  expires_at: number;
}

// ---------------------------------------------------------------------------
// Per-upload mutex
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();

async function withSessionLock<T>(uploadId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(uploadId);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  locks.set(uploadId, gate);
  if (prev) {
    try {
      await prev;
    } catch {
      /* ignore */
    }
  }
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(uploadId) === gate) locks.delete(uploadId);
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function sessionDir(plugin: PluginInfo, uploadId: string): string {
  return join(plugin.dataDir, "uploads.in_progress", uploadId);
}

function dataPath(plugin: PluginInfo, uploadId: string): string {
  return join(sessionDir(plugin, uploadId), "data");
}

function metaPath(plugin: PluginInfo, uploadId: string): string {
  return join(sessionDir(plugin, uploadId), "meta.json");
}

async function readSessionMeta(
  plugin: PluginInfo,
  uploadId: string,
): Promise<UploadSessionMeta | null> {
  try {
    const raw = await readFile(metaPath(plugin, uploadId), "utf8");
    const parsed = JSON.parse(raw) as UploadSessionMeta;
    return parsed;
  } catch {
    return null;
  }
}

async function writeSessionMeta(
  plugin: PluginInfo,
  meta: UploadSessionMeta,
): Promise<void> {
  const final = metaPath(plugin, meta.upload_id);
  const tmp = `${final}.tmp`;
  await writeFile(tmp, JSON.stringify(meta), "utf8");
  await rename(tmp, final);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** UUID-shape check. crypto.randomUUID() produces 36-char lowercase hex+dashes. */
function looksLikeUploadId(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function jsonError(
  code: string,
  message: string,
  status: number,
  extra?: Record<string, unknown>,
): Response {
  return Response.json({ error: { code, message, ...(extra ?? {}) } }, { status });
}

function rateLimitedResponse(retryAfterMs: number): Response {
  const retryAfterSec = Math.ceil(retryAfterMs / 1000);
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "Too many requests.", retryAfter: retryAfterSec } },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

// ---------------------------------------------------------------------------
// OPTIONS preflight — sandboxed iframes hit /upload/* with Origin: null and
// need the method/header negotiation before the real request lands.
// ---------------------------------------------------------------------------

export function handleUploadSessionPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: new Headers({
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, Content-Length, X-Plugin, X-Filename",
      "Access-Control-Max-Age": "600",
    }),
  });
}

// ---------------------------------------------------------------------------
// POST /upload/init
// ---------------------------------------------------------------------------

export async function handleUploadInit(
  request: Request,
  _params: Record<string, string>,
  deps: HttpDependencies,
  rateLimiter: RateLimiter,
  clientIp: string,
): Promise<Response> {
  const auth = await extractAuth(request, deps.tokenValidator);
  if (!auth.ok) {
    rateLimiter.recordAuthFailure(clientIp);
    return auth.response;
  }
  rateLimiter.recordAuthSuccess(clientIp);

  const rateResult = rateLimiter.consume(`user:${auth.user.id}`, RATE_UPLOAD);
  if (!rateResult.allowed) return rateLimitedResponse(rateResult.retryAfterMs);

  const pluginSlug = request.headers.get("x-plugin");
  if (!pluginSlug) {
    return jsonError("MISSING_PLUGIN_HEADER", "X-Plugin header is required.", 400);
  }

  const plugin = deps.pluginRegistry.getPlugin(pluginSlug);
  if (!plugin) {
    return jsonError("PLUGIN_NOT_FOUND", `Plugin "${pluginSlug}" not found.`, 404);
  }

  const checker = new CapabilityChecker(pluginSlug, plugin.manifest.permissions);
  const capCheck = checker.check("storage.file:self");
  if (!capCheck.ok) return jsonError(capCheck.code, capCheck.message, 403);

  let parsed: { total_bytes?: unknown; original_name?: unknown };
  try {
    parsed = (await request.json()) as { total_bytes?: unknown; original_name?: unknown };
  } catch {
    return jsonError("INVALID_BODY", "Body must be JSON.", 400);
  }

  const totalBytes = Number(parsed.total_bytes);
  if (!Number.isFinite(totalBytes) || !Number.isInteger(totalBytes) || totalBytes < 0) {
    return jsonError("INVALID_TOTAL_SIZE", "total_bytes must be a non-negative integer.", 400);
  }
  if (totalBytes === 0) {
    return jsonError("EMPTY_BODY", "total_bytes is 0.", 400);
  }

  const effectiveCeiling = Math.min(HARD_UPLOAD_CEILING, deps.config.maxUploadBytes);
  if (totalBytes > effectiveCeiling) {
    return jsonError(
      "PAYLOAD_TOO_LARGE",
      `File exceeds maximum size of ${effectiveCeiling} bytes.`,
      413,
    );
  }

  let originalName = "";
  if (typeof parsed.original_name === "string") {
    originalName = parsed.original_name.slice(0, 255);
  }

  const uploadId = crypto.randomUUID();
  const now = Date.now();
  const meta: UploadSessionMeta = {
    upload_id: uploadId,
    plugin_slug: pluginSlug,
    user_id: auth.user.id,
    original_name: originalName,
    total_bytes: totalBytes,
    received_bytes: 0,
    head_b64: "",
    created_at: now,
    expires_at: now + SESSION_TTL_MS,
  };

  try {
    await mkdir(sessionDir(plugin, uploadId), { recursive: true });
    // Touch the data file so PATCH appends find it.
    const fh = await fsOpen(dataPath(plugin, uploadId), "w");
    await fh.close();
    await writeSessionMeta(plugin, meta);
  } catch (err) {
    log.error("upload-session init failed", {
      slug: pluginSlug,
      uploadId,
      err: errMsg(err),
    });
    return jsonError("INTERNAL_ERROR", "Failed to allocate upload session.", 500);
  }

  return Response.json(
    {
      ok: true,
      upload_id: uploadId,
      chunk_size: CHUNK_SIZE,
      total_bytes: totalBytes,
      received_bytes: 0,
      expires_at: meta.expires_at,
    },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// GET /upload/<id>
// ---------------------------------------------------------------------------

export async function handleUploadStatus(
  request: Request,
  params: Record<string, string>,
  deps: HttpDependencies,
  rateLimiter: RateLimiter,
  clientIp: string,
): Promise<Response> {
  const uploadId = params["id"]!;
  if (!looksLikeUploadId(uploadId)) {
    return jsonError("NOT_FOUND", "Upload session not found.", 404);
  }

  const auth = await extractAuth(request, deps.tokenValidator);
  if (!auth.ok) {
    rateLimiter.recordAuthFailure(clientIp);
    return auth.response;
  }
  rateLimiter.recordAuthSuccess(clientIp);

  const rateResult = rateLimiter.consume(`user:${auth.user.id}`, RATE_UPLOAD);
  if (!rateResult.allowed) return rateLimitedResponse(rateResult.retryAfterMs);

  const pluginSlug = request.headers.get("x-plugin");
  if (!pluginSlug) {
    return jsonError("MISSING_PLUGIN_HEADER", "X-Plugin header is required.", 400);
  }
  const plugin = deps.pluginRegistry.getPlugin(pluginSlug);
  if (!plugin) {
    return jsonError("PLUGIN_NOT_FOUND", `Plugin "${pluginSlug}" not found.`, 404);
  }

  const meta = await readSessionMeta(plugin, uploadId);
  if (!meta) return jsonError("NOT_FOUND", "Upload session not found.", 404);
  if (meta.user_id !== auth.user.id) {
    return jsonError("FORBIDDEN", "Upload session belongs to a different user.", 403);
  }
  if (meta.plugin_slug !== pluginSlug) {
    return jsonError("FORBIDDEN", "Upload session belongs to a different plugin.", 403);
  }
  if (Date.now() > meta.expires_at) {
    return jsonError("UPLOAD_EXPIRED", "Upload session has expired.", 410);
  }

  return Response.json({
    ok: true,
    upload_id: meta.upload_id,
    total_bytes: meta.total_bytes,
    received_bytes: meta.received_bytes,
    expires_at: meta.expires_at,
  });
}

// ---------------------------------------------------------------------------
// PATCH /upload/<id>?offset=N
// ---------------------------------------------------------------------------

export async function handleUploadPatch(
  request: Request,
  params: Record<string, string>,
  deps: HttpDependencies,
  rateLimiter: RateLimiter,
  clientIp: string,
): Promise<Response> {
  const uploadId = params["id"]!;
  if (!looksLikeUploadId(uploadId)) {
    return jsonError("NOT_FOUND", "Upload session not found.", 404);
  }

  const auth = await extractAuth(request, deps.tokenValidator);
  if (!auth.ok) {
    rateLimiter.recordAuthFailure(clientIp);
    return auth.response;
  }
  rateLimiter.recordAuthSuccess(clientIp);

  const rateResult = rateLimiter.consume(`user:${auth.user.id}`, RATE_UPLOAD_CHUNK);
  if (!rateResult.allowed) return rateLimitedResponse(rateResult.retryAfterMs);

  const pluginSlug = request.headers.get("x-plugin");
  if (!pluginSlug) {
    return jsonError("MISSING_PLUGIN_HEADER", "X-Plugin header is required.", 400);
  }
  const plugin = deps.pluginRegistry.getPlugin(pluginSlug);
  if (!plugin) {
    return jsonError("PLUGIN_NOT_FOUND", `Plugin "${pluginSlug}" not found.`, 404);
  }

  const checker = new CapabilityChecker(pluginSlug, plugin.manifest.permissions);
  const capCheck = checker.check("storage.file:self");
  if (!capCheck.ok) return jsonError(capCheck.code, capCheck.message, 403);

  const url = new URL(request.url);
  const offsetRaw = url.searchParams.get("offset");
  if (offsetRaw === null) {
    return jsonError("MISSING_OFFSET", "offset query parameter is required.", 400);
  }
  const offset = Number(offsetRaw);
  if (!Number.isFinite(offset) || !Number.isInteger(offset) || offset < 0) {
    return jsonError("INVALID_OFFSET", "offset must be a non-negative integer.", 400);
  }

  const contentLengthRaw = request.headers.get("content-length");
  if (contentLengthRaw === null) {
    return jsonError("LENGTH_REQUIRED", "Content-Length is required.", 411);
  }
  const declared = Number(contentLengthRaw);
  if (!Number.isFinite(declared) || !Number.isInteger(declared) || declared < 0) {
    return jsonError("INVALID_CONTENT_LENGTH", "Content-Length must be a non-negative integer.", 400);
  }
  if (declared === 0) {
    return jsonError("EMPTY_BODY", "Chunk body is empty.", 400);
  }
  if (declared > CHUNK_SIZE) {
    return jsonError("PAYLOAD_TOO_LARGE", `Chunk exceeds ${CHUNK_SIZE} bytes.`, 413);
  }

  const body = request.body;
  if (!body) return jsonError("EMPTY_BODY", "Chunk body is empty.", 400);

  return withSessionLock(uploadId, async () => {
    const meta = await readSessionMeta(plugin, uploadId);
    if (!meta) return jsonError("NOT_FOUND", "Upload session not found.", 404);
    if (meta.user_id !== auth.user.id) {
      return jsonError("FORBIDDEN", "Upload session belongs to a different user.", 403);
    }
    if (meta.plugin_slug !== pluginSlug) {
      return jsonError("FORBIDDEN", "Upload session belongs to a different plugin.", 403);
    }
    if (Date.now() > meta.expires_at) {
      return jsonError("UPLOAD_EXPIRED", "Upload session has expired.", 410);
    }

    // Idempotency:
    //   offset == received_bytes → append
    //   offset <  received_bytes → 409 RANGE_CONFLICT (client must GET to resync)
    //   offset >  received_bytes → 416 RANGE_NOT_SATISFIABLE (no gaps allowed)
    if (offset < meta.received_bytes) {
      return jsonError(
        "RANGE_CONFLICT",
        "Offset is behind server state — fetch /upload/<id> for authoritative received_bytes.",
        409,
        { received_bytes: meta.received_bytes },
      );
    }
    if (offset > meta.received_bytes) {
      return Response.json(
        {
          error: {
            code: "RANGE_NOT_SATISFIABLE",
            message: "Offset is ahead of server state.",
            received_bytes: meta.received_bytes,
          },
        },
        {
          status: 416,
          headers: { "Content-Range": `bytes */${meta.total_bytes}` },
        },
      );
    }

    const remaining = meta.total_bytes - meta.received_bytes;
    if (declared > remaining) {
      return jsonError(
        "LENGTH_MISMATCH",
        `Chunk extends past total_bytes (remaining=${remaining}).`,
        400,
      );
    }

    const fh = await fsOpen(dataPath(plugin, uploadId), "a");
    const reader = body.getReader();
    let written = 0;
    // Capture head bytes if we haven't yet. First-chunk-at-offset-0 case.
    let head: Uint8Array | null = null;
    if (meta.received_bytes === 0 && meta.head_b64 === "") {
      head = new Uint8Array(0);
    }

    // If the client disconnects mid-stream (Cloudflare tunnel drop, Wi-Fi
    // blip, browser tab close), cancel the reader so the lock releases
    // promptly — otherwise the next retry PATCH for this upload_id would
    // queue behind a zombie reader that may never see done/error from the
    // half-open TCP stream.
    const clientSignal = request.signal;
    if (clientSignal) {
      const onClientAbort = (): void => {
        reader.cancel().catch(() => { /* already closed */ });
      };
      if (clientSignal.aborted) {
        onClientAbort();
      } else {
        clientSignal.addEventListener("abort", onClientAbort, { once: true });
      }
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        if (written + value.byteLength > declared) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          try {
            await fh.close();
          } catch {
            /* ignore */
          }
          return jsonError("LENGTH_MISMATCH", "Body exceeded declared Content-Length.", 400);
        }

        if (head !== null && head.length < 64) {
          const need = 64 - head.length;
          const extra = value.subarray(0, Math.min(value.byteLength, need));
          const merged = new Uint8Array(head.length + extra.length);
          merged.set(head, 0);
          merged.set(extra, head.length);
          head = merged;
        }

        await fh.write(value);
        written += value.byteLength;
      }
    } catch (err) {
      log.error("upload-session patch stream failed", { uploadId, err: errMsg(err) });
      try {
        await fh.close();
      } catch {
        /* ignore */
      }
      // Partial bytes may have landed via append-mode writes before the read
      // failed. Truncate back to the last-known-good received_bytes so the
      // next retry PATCH appends at the right boundary instead of past it.
      try {
        const truncFh = await fsOpen(dataPath(plugin, uploadId), "r+");
        await truncFh.truncate(meta.received_bytes);
        await truncFh.close();
      } catch {
        /* best-effort — meta is authoritative; mismatch surfaces at finalize */
      }
      return jsonError("UPLOAD_FAILED", "Chunk write was interrupted.", 500);
    }

    try {
      await fh.sync();
    } catch {
      /* best-effort */
    }
    try {
      await fh.close();
    } catch {
      /* ignore */
    }

    if (written !== declared) {
      // Body shorter than declared. Do NOT advance received_bytes; client can
      // retry at the same offset. Truncate the partial write so the data file
      // stays consistent with received_bytes.
      try {
        const truncFh = await fsOpen(dataPath(plugin, uploadId), "r+");
        await truncFh.truncate(meta.received_bytes);
        await truncFh.close();
      } catch {
        /* best-effort — meta is authoritative */
      }
      return jsonError("LENGTH_MISMATCH", "Body shorter than declared Content-Length.", 400);
    }

    const now = Date.now();
    const updated: UploadSessionMeta = {
      ...meta,
      received_bytes: meta.received_bytes + written,
      expires_at: now + SESSION_TTL_MS,
      head_b64:
        head !== null && head.length > 0
          ? Buffer.from(head).toString("base64")
          : meta.head_b64,
    };
    await writeSessionMeta(plugin, updated);

    return Response.json({
      ok: true,
      upload_id: uploadId,
      received_bytes: updated.received_bytes,
      total_bytes: updated.total_bytes,
      expires_at: updated.expires_at,
    });
  });
}

// ---------------------------------------------------------------------------
// POST /upload/<id>/finalize
// ---------------------------------------------------------------------------

export async function handleUploadFinalize(
  request: Request,
  params: Record<string, string>,
  deps: HttpDependencies,
  rateLimiter: RateLimiter,
  clientIp: string,
): Promise<Response> {
  const uploadId = params["id"]!;
  if (!looksLikeUploadId(uploadId)) {
    return jsonError("NOT_FOUND", "Upload session not found.", 404);
  }

  const auth = await extractAuth(request, deps.tokenValidator);
  if (!auth.ok) {
    rateLimiter.recordAuthFailure(clientIp);
    return auth.response;
  }
  rateLimiter.recordAuthSuccess(clientIp);

  const rateResult = rateLimiter.consume(`user:${auth.user.id}`, RATE_UPLOAD);
  if (!rateResult.allowed) return rateLimitedResponse(rateResult.retryAfterMs);

  const pluginSlug = request.headers.get("x-plugin");
  if (!pluginSlug) {
    return jsonError("MISSING_PLUGIN_HEADER", "X-Plugin header is required.", 400);
  }
  const plugin = deps.pluginRegistry.getPlugin(pluginSlug);
  if (!plugin) {
    return jsonError("PLUGIN_NOT_FOUND", `Plugin "${pluginSlug}" not found.`, 404);
  }

  const checker = new CapabilityChecker(pluginSlug, plugin.manifest.permissions);
  const capCheck = checker.check("storage.file:self");
  if (!capCheck.ok) return jsonError(capCheck.code, capCheck.message, 403);

  return withSessionLock(uploadId, async () => {
    const meta = await readSessionMeta(plugin, uploadId);
    if (!meta) return jsonError("NOT_FOUND", "Upload session not found.", 404);
    if (meta.user_id !== auth.user.id) {
      return jsonError("FORBIDDEN", "Upload session belongs to a different user.", 403);
    }
    if (meta.plugin_slug !== pluginSlug) {
      return jsonError("FORBIDDEN", "Upload session belongs to a different plugin.", 403);
    }
    if (Date.now() > meta.expires_at) {
      return jsonError("UPLOAD_EXPIRED", "Upload session has expired.", 410);
    }
    if (meta.received_bytes !== meta.total_bytes) {
      return jsonError(
        "INCOMPLETE_UPLOAD",
        `Received ${meta.received_bytes}/${meta.total_bytes} bytes.`,
        409,
        { received_bytes: meta.received_bytes, total_bytes: meta.total_bytes },
      );
    }

    // Verify on-disk size matches received_bytes — defense in depth against a
    // corrupted append. INTEGRITY_FAILED here is a hard reject; the client
    // can retry by re-uploading from scratch.
    const data = dataPath(plugin, uploadId);
    let onDiskSize: number;
    try {
      const s = await stat(data);
      onDiskSize = s.size;
    } catch (err) {
      log.error("upload-session finalize stat failed", { uploadId, err: errMsg(err) });
      return jsonError("INTERNAL_ERROR", "Upload data file is missing.", 500);
    }
    if (onDiskSize !== meta.total_bytes) {
      log.error("upload-session integrity mismatch", {
        uploadId,
        onDiskSize,
        expected: meta.total_bytes,
      });
      return jsonError(
        "INTEGRITY_FAILED",
        `On-disk size ${onDiskSize} != expected ${meta.total_bytes}.`,
        422,
      );
    }

    // Sniff MIME from the saved head bytes — same untrusted-Content-Type
    // discipline as single-shot /upload.
    let sniffed = "application/octet-stream";
    if (meta.head_b64.length > 0) {
      try {
        const head = Buffer.from(meta.head_b64, "base64");
        sniffed = sniffMime(
          new Uint8Array(head.buffer, head.byteOffset, head.byteLength),
        );
      } catch {
        sniffed = "application/octet-stream";
      }
    }
    const ext = extensionForMime(sniffed);
    const safeFilename = ext ? `${uploadId}.${ext}` : uploadId;
    const uploadsDir = join(plugin.dataDir, "uploads");
    const finalPath = join(uploadsDir, safeFilename);

    try {
      await mkdir(uploadsDir, { recursive: true });
      await rename(data, finalPath);
    } catch (err) {
      log.error("upload-session finalize commit failed", { uploadId, err: errMsg(err) });
      return jsonError("INTERNAL_ERROR", "Failed to commit upload.", 500);
    }

    // Best-effort cleanup of the now-empty session dir + meta.json.
    try {
      await rm(sessionDir(plugin, uploadId), { recursive: true, force: true });
    } catch {
      /* ignore */
    }

    const notification: FileUploadNotification = {
      type: "file.uploaded",
      filename: safeFilename,
      path: finalPath,
      size: meta.total_bytes,
      mimeType: sniffed,
      uploadedBy: auth.user.id,
      uploadedAt: Date.now(),
    };
    deps.notifyPlugin(pluginSlug, notification);

    return Response.json(
      {
        ok: true,
        filename: safeFilename,
        size: meta.total_bytes,
        mime: sniffed,
        originalName: meta.original_name,
      },
      { status: 201 },
    );
  });
}

// ---------------------------------------------------------------------------
// DELETE /upload/<id>
// ---------------------------------------------------------------------------

export async function handleUploadCancel(
  request: Request,
  params: Record<string, string>,
  deps: HttpDependencies,
  rateLimiter: RateLimiter,
  clientIp: string,
): Promise<Response> {
  const uploadId = params["id"]!;
  if (!looksLikeUploadId(uploadId)) {
    return jsonError("NOT_FOUND", "Upload session not found.", 404);
  }

  const auth = await extractAuth(request, deps.tokenValidator);
  if (!auth.ok) {
    rateLimiter.recordAuthFailure(clientIp);
    return auth.response;
  }
  rateLimiter.recordAuthSuccess(clientIp);

  const rateResult = rateLimiter.consume(`user:${auth.user.id}`, RATE_UPLOAD);
  if (!rateResult.allowed) return rateLimitedResponse(rateResult.retryAfterMs);

  const pluginSlug = request.headers.get("x-plugin");
  if (!pluginSlug) {
    return jsonError("MISSING_PLUGIN_HEADER", "X-Plugin header is required.", 400);
  }
  const plugin = deps.pluginRegistry.getPlugin(pluginSlug);
  if (!plugin) {
    return jsonError("PLUGIN_NOT_FOUND", `Plugin "${pluginSlug}" not found.`, 404);
  }

  return withSessionLock(uploadId, async () => {
    const meta = await readSessionMeta(plugin, uploadId);
    if (!meta) {
      // Idempotent — cancelling something that doesn't exist is a no-op.
      return Response.json({ ok: true, deleted: false }, { status: 200 });
    }
    if (meta.user_id !== auth.user.id) {
      return jsonError("FORBIDDEN", "Upload session belongs to a different user.", 403);
    }
    if (meta.plugin_slug !== pluginSlug) {
      return jsonError("FORBIDDEN", "Upload session belongs to a different plugin.", 403);
    }

    try {
      await rm(sessionDir(plugin, uploadId), { recursive: true, force: true });
    } catch (err) {
      log.error("upload-session cancel cleanup failed", { uploadId, err: errMsg(err) });
    }
    return Response.json({ ok: true, deleted: true });
  });
}

// ---------------------------------------------------------------------------
// GC sweep — walks every plugin's uploads.in_progress/ and removes sessions
// whose meta.json.expires_at is past. Called at boot and every SWEEP_INTERVAL_MS.
// ---------------------------------------------------------------------------

export async function sweepStaleUploadSessions(
  pluginRegistry: PluginRegistry,
  now: number = Date.now(),
): Promise<{ scanned: number; removed: number }> {
  let scanned = 0;
  let removed = 0;
  for (const plugin of pluginRegistry.listPlugins()) {
    const dir = join(plugin.dataDir, "uploads.in_progress");
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!looksLikeUploadId(name)) continue;
      scanned++;
      const meta = await readSessionMeta(plugin, name);
      let stale = false;
      if (!meta) {
        // Orphan dir (no meta) — sweep if dir mtime is past the TTL window.
        try {
          const s = await stat(join(dir, name));
          stale = now - s.mtimeMs > SESSION_TTL_MS;
        } catch {
          stale = true;
        }
      } else {
        stale = now > meta.expires_at;
      }
      if (stale) {
        try {
          await rm(join(dir, name), { recursive: true, force: true });
          removed++;
        } catch {
          /* best-effort */
        }
      }
    }
  }
  return { scanned, removed };
}
