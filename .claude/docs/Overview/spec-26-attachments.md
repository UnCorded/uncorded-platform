---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Files live with the server. The runtime owns transport; the plugin owns meaning."
depends-on: [spec-03-server-container, spec-04-plugin-architecture, spec-05-plugin-data-model, spec-06-authentication, spec-09-client-apps]
last-verified: 2026-05-13
amendments: [A]
---

# 26 — File Attachments

*One primitive — the runtime-owned file store — that any plugin can opt into by declaring `storage.file:self`. Streams in, signs out, and never bakes a hostname into anything.*

---

## Why This Exists

Two real plugin needs converge on the same primitive:

1. **text-channels attachments** — the user opening this spec wants drag-drop file sends in chat, with inline previews for the common cases (image, video, audio, PDF, code, markdown, zip explore).
2. **Future plugins** — a gallery plugin, a docs plugin, a CDN-style asset plugin, and screen-share-recording uploads all want the same shape: "accept a body, write it to my data dir, give me a URL I can hand to the client".

Building these per-plugin would mean N upload endpoints, N auth surfaces, N orphan-GC schemes, and N ways to leak file URLs across server-URL changes.

**This spec defines that shared primitive.** Plugins declare `storage.file:self`, get a runtime-mediated upload endpoint and a signed-URL serve endpoint, and own their own size/count limits via the standard plugin-settings system.

The product story for text-channels in particular: **"Send anything up to your server's configured ceiling. Server owner picks the ceiling, from 5 MB to 5 GB."** Files live on the server container the same way messages do — the portable-server model is preserved end-to-end. Multi-GB transfers are made reliable by the chunked resumable upload protocol — see **Amendment A**.

---

## Locked Decisions

- **Files live on the server container's disk.** Per-plugin directory: `<plugin.dataDir>/uploads/<safe-filename>`. No external object store, no Central involvement, no per-user buckets. The same Docker volume that holds the plugin's SQLite holds its files. Backup story: whoever backs up `dataDir` backs up attachments.
- **One runtime upload endpoint family.** `POST /upload` is the fast path for files at or under the single-shot threshold (50 MB — see Amendment A). The `POST /upload/init` / `PATCH /upload/<id>` / `POST /upload/<id>/finalize` family handles everything else with resumable semantics. Both paths share auth (Bearer + `X-Plugin`), capability gating (`storage.file:self`), per-user rate limiting (`RATE_UPLOAD`), magic-byte MIME sniffing, atomic-rename commit, and `.tmp` cleanup. Bodies always stream — never buffer into memory.
- **One runtime serve endpoint: `GET /files/:slug/:filename`.** Auth via signed query parameters only (`?t=<hmac>&exp=<ts>&u=<user_id>`). No Bearer header on the GET path, because `<img src>` / `<video src>` cannot set headers. Range requests are first-class; the endpoint streams ranged byte slices.
- **Stored URLs are path-relative, never absolute.** `messages.attachments[i].url` is `/files/text-channels/<filename>?t=...&exp=...&u=...` — no scheme, no host. The client prepends its current server origin at render time. This keeps URLs valid across try.cloudflare hostname flips, permanent-tunnel migrations, and future private-invite URL schemes; the server's advertised URL is whatever it currently is, and the client already knows it (it connected through it).
- **Signatures are minted fresh on every read.** Backend never returns a stored signed URL. On every `getMessages` / `getMessage` / WS broadcast that carries attachment records, the plugin re-mints a signed URL bound to the requesting user with a short TTL (1 hour). Means signatures can be HMACed against a boot-secret that resets on container restart — old URLs become invalid, clients refetch and get fresh ones.
- **The signing secret never persists.** Generated in-memory on runtime boot via `crypto.getRandomValues(new Uint8Array(32))`. Lost on restart. Cost: messages cached client-side past a runtime restart re-fetch to refresh URLs. Benefit: one less secret on disk; rotation is automatic.
- **Signature payload is exactly: `HMAC-SHA256(secret, "<path>|<exp>|<user_id>")`, base64url-encoded.** Constant-time compare on verify. `path` is the canonical request path `/files/:slug/:filename`. `exp` is a unix-seconds expiry. `user_id` binds the URL to a single user (a leaked URL doesn't grant cross-user access).
- **Runtime hard cap = 5 GB.** `maxUploadBytes` default is **5 368 709 120 bytes** (raised from 1 GB in Amendment A). The hard ceiling exists so a misconfigured plugin can't accept 100 GB uploads and fill the host disk. Plugins enforce their own lower cap via their settings (see below). The runtime accepts files up to the ceiling on either the single-shot or chunked path — the SDK chooses based on file size (>50 MB → chunked, for reliability), but the server does not refuse a single-shot upload of any size below the ceiling.
- **Plugins enforce their own per-file cap in their `sendMessage`-equivalent handler, NOT at upload time.** The runtime upload endpoint accepts up to its ceiling. If an upload arrives larger than the plugin's current `attachments_max_bytes` setting, the plugin rejects the *attachment-attach* call (the file is already on disk; it becomes an orphan and is GC'd). This avoids coupling the runtime to per-plugin settings — the runtime stays generic, plugins stay authoritative over their own limits.
- **Filenames on disk are server-generated, never client-supplied.** Format: `${Date.now()}-${crypto.randomUUID()}<ext>` where `<ext>` comes from MIME sniffing on the byte stream, falling back to `.bin`. The user-facing "original filename" is sent by the client as the `X-Filename` header (RFC 5987 encoded) and stored in the plugin's DB as part of the attachment record — never used as a filesystem path.
- **MIME is sniffed from magic bytes during upload, not trusted from the client `Content-Type` header.** Recognized families: image/*, video/mp4, video/webm, audio/mpeg, audio/ogg, audio/wav, application/pdf, application/zip. Unknown types are stored as `application/octet-stream` and served with `Content-Disposition: attachment` by default. The client's `Content-Type` header is a hint only; the sniffed value wins.
- **SVG is treated as a media type but serves with `Content-Disposition: attachment` by default and `inline` only when the client passes `?inline=svg` AND the bytes pass a strict sanitization check at render time (DOMPurify in the iframe). SVG is the highest XSS risk in the file pipeline.
- **`X-Content-Type-Options: nosniff` is set on every serve response.** Browsers honor the server-declared MIME exactly; no sniffing into HTML/JS execution paths.
- **Orphan GC runs in the plugin, not the runtime.** A plugin that owns uploads is responsible for sweeping its own `<dataDir>/uploads/` directory periodically: list files, query its own DB for referenced filenames, delete files that are (a) unreferenced AND (b) older than 1 hour. Sweep runs on plugin startup and every hour after. The 1-hour grace lets an in-progress send finish cleanly.
- **All file types are accepted.** No allowlist or denylist at the upload boundary. The defense is at the serve boundary: unknown types serve as `attachment` (downloaded, never inline-rendered), `nosniff` prevents browser-side content-type inference, and the iframe sandbox attribute prevents script execution from any served content even if MIME spoofing occurred.
- **The signed-URL TTL is 1 hour.** Short enough that a leaked URL becomes a stale URL within a working session. Long enough that a tab left open for a coffee break still renders attachments without refetch.
- **Attachments are immutable per upload.** Once written, the file at `<dataDir>/uploads/<filename>` never changes. New uploads get new UUIDs. Edits to a message that change its attachments don't mutate any file — they just change which filenames the message references. Old files become orphans, GC sweeps.

---

## Threat Model

### What we defend against

- **Server-disk OOM via unbounded buffering.** Streaming write means N concurrent 5-GB uploads pin O(chunk-size × N) memory, not O(5 GB × N).
- **Path traversal via crafted filenames.** Server generates all filenames. URL path regex matches `^[A-Za-z0-9_-]+-[A-Za-z0-9-]{36}\.[A-Za-z0-9]+$` exactly; anything else is 400.
- **MIME spoofing → XSS.** Magic-byte sniffing on write + `nosniff` + `attachment` default for unknown types + iframe sandbox.
- **Cross-user URL leakage.** Signatures bind URLs to a `user_id`. A URL emitted for user A doesn't work for user B; their backend mints a different signature.
- **Replay past intent.** Signed URLs expire at 1 hour. A leaked URL stops working before most ad-hoc message-sharing sessions end.
- **Tunnel-URL drift.** Stored URLs are path-only. Hostname changes (try.cloudflare restart, tunnel migration, private invite resolve) do not invalidate stored references; the client prepends whatever hostname it currently connected through.
- **File pinning past message delete.** Plugin GC sweeps; deleted-message attachments become unreferenced and are removed within the next sweep cycle.

### What we do not defend against

- **Compromise of the host machine running the container.** Attachments are at rest in plaintext. Anyone with shell access to the container's volume reads everything. This is acceptable per the self-hosted threat model — owning the box owns the data.
- **Server-owner snooping.** The server owner can read all attachments via the disk. Documented; matches the rest of the platform's "owner is trusted" posture.
- **Content-level abuse (malware, CSAM, harassment).** Out of scope at the file layer. Plugins (text-channels, future moderation tools) may add scanning, takedown flows, etc. on top.
- **Network-level confidentiality of attachments past TLS.** TLS via Cloudflare protects in-flight. No additional E2E.
- **Bandwidth amplification.** A user can repeatedly fetch a 5-GB attachment within the per-user rate budget. Documented as a future refinement.

---

## Wire Format

### The Attachment Record

Plugins store attachments however they like, but the **wire shape returned to clients** is canonical:

```ts
interface Attachment {
  /** Server-generated filename on disk (UUID + ext). Stable across reads. */
  filename: string;
  /** Original client-supplied filename. Display only. May contain unicode. */
  original_name: string;
  /** Sniffed MIME type. Always present; falls back to "application/octet-stream". */
  mime: string;
  /** Byte size on disk. */
  size: number;
  /** Optional dimensions, set when sniffer extracted them (image/video). */
  width?: number;
  height?: number;
  /** Optional duration in seconds, set for audio/video where extractable. */
  duration?: number;
  /** Path-only signed URL. Client prepends server origin at render time.
   *  Format: /files/<slug>/<filename>?t=<sig>&exp=<ts>&u=<user_id> */
  url: string;
}
```

`url` is regenerated per-read by the plugin backend bound to the requesting user. Plugins never store `url` in their database — only `filename` + metadata.

### Upload Request

```
POST /upload HTTP/1.1
Authorization: Bearer <runtime-issued JWT>
Content-Type: <client-declared MIME, hint only>
Content-Length: <byte size>
X-Plugin: text-channels
X-Filename: <RFC-5987-encoded original filename>
<body stream>
```

### Upload Response

```json
HTTP/1.1 201 Created
Content-Type: application/json

{
  "ok": true,
  "filename": "1715628000000-9b1a8e2f-b9c4-4d6f-a1e3-7a8b3e2c1d9f.png",
  "size": 524288,
  "mime": "image/png",
  "width": 1920,
  "height": 1080
}
```

### Serve Request

```
GET /files/text-channels/1715628000000-9b1a8e2f-...-9f.png?t=<sig>&exp=1715631600&u=<user_id> HTTP/1.1
Range: bytes=0-1048575
```

### Serve Response

```
HTTP/1.1 206 Partial Content
Content-Type: image/png
Content-Length: 1048576
Content-Range: bytes 0-1048575/5242880
Content-Disposition: inline; filename*=UTF-8''vacation.png
X-Content-Type-Options: nosniff
Cache-Control: private, max-age=3600, immutable
ETag: "<filename>"
Accept-Ranges: bytes
```

`?download=1` flips `Content-Disposition` from `inline` to `attachment`.

---

## Plugin Contract

A plugin that wants file attachments declares the capability and adds settings:

```json
{
  "permissions": [
    "storage.file:self",
    "..."
  ],
  "settings": [
    {
      "key": "attachments_enabled",
      "label": "Allow file attachments",
      "description": "Master switch. When off, the Attach button is hidden.",
      "type": "boolean",
      "default": true
    },
    {
      "key": "attachments_max_bytes",
      "label": "Max file size",
      "description": "Per-file upload limit. Runtime enforces 5 GB as a hard ceiling.",
      "type": "number",
      "default": 5368709120,
      "stops": [
        { "value": 5242880,    "label": "5 MB" },
        { "value": 26214400,   "label": "25 MB" },
        { "value": 104857600,  "label": "100 MB" },
        { "value": 524288000,  "label": "500 MB" },
        { "value": 1073741824, "label": "1 GB" },
        { "value": 5368709120, "label": "5 GB" }
      ]
    },
    {
      "key": "attachments_max_per_message",
      "label": "Attachments per message",
      "description": "Maximum number of files allowed in a single message.",
      "type": "number",
      "default": 10,
      "stops": [
        { "value": 1, "label": "1" },
        { "value": 5, "label": "5" },
        { "value": 10, "label": "10" },
        { "value": 25, "label": "25" }
      ]
    }
  ]
}
```

The plugin's `sendMessage`-equivalent handler validates each attachment record against the current settings via `plugin.settings.getAll()`, looks up file metadata via the runtime SDK (see below), and persists references.

### Backend SDK additions

```ts
// In plugin.files (capability-gated by storage.file:self)
interface FilesApi {
  /** Look up a file the runtime has stored for this plugin. Returns null
   *  if the file doesn't exist. Used by sendMessage to validate that an
   *  attachment the frontend claims to have uploaded actually exists. */
  stat(filename: string): Promise<{ size: number; mime: string; created_at: number } | null>;

  /** Mint a path-only signed URL for the given filename, bound to user_id,
   *  expiring after ttlSec seconds (default 3600). The plugin re-mints on
   *  every read; never store the URL. */
  signUrl(filename: string, opts: { userId: string; ttlSec?: number }): string;

  /** Delete a file. Idempotent — silently no-ops if the file is gone. */
  delete(filename: string): Promise<void>;

  /** List all files under this plugin's uploads dir. Used by orphan GC. */
  list(): Promise<Array<{ filename: string; size: number; created_at: number }>>;
}
```

### Orphan GC contract

Every plugin with `storage.file:self` must implement a sweep that runs:
- once at startup
- every 60 minutes thereafter

The sweep:
1. Calls `plugin.files.list()` to get all files on disk.
2. Queries its own DB for referenced filenames.
3. Deletes files in (disk − referenced) where `now - created_at > 1 hour`.

The 1-hour grace lets an in-flight send (upload completed, sendMessage not yet called) finish without losing its file.

---

## Runtime Contract

### Capability check

`storage.file:self` is the existing capability (`runtime/src/capabilities/checker.ts`). The runtime checks it before accepting an upload and refuses serve requests for filenames under plugin directories that don't declare it.

### Signing module

Lives in `runtime/src/signing/files.ts`. Exports:

```ts
/** Boot-secret. Regenerated on every runtime start. Never persisted. */
let FILE_SIGNING_SECRET: Uint8Array;

export function initFileSigning(): void;
export function signFilePath(path: string, exp: number, userId: string): string;
export function verifyFileSig(path: string, exp: number, userId: string, sig: string): boolean;
```

`verifyFileSig` uses constant-time comparison.

### Upload handler invariants

1. Auth + rate limit + capability check happen **before** the body is read.
2. `Content-Length` is required. Missing → 411.
3. `Content-Length > maxUploadBytes` (5 GB default) → 413, body never read.
4. Body is streamed: `request.body.getReader()` → `Bun.file(`<dir>/<filename>.tmp`).writer()`. Chunks are size-counted; running total exceeding the cap → abort, delete `.tmp`, 413.
5. First 16 KB are passed through a magic-byte sniffer. Sniffed MIME wins over client header.
6. On successful close: atomic rename `.tmp` → final filename. On any error path: delete `.tmp` (best-effort, logged on failure).
7. Plugin is notified via `file.uploaded` IPC with `{ filename, size, mime, originalName, uploadedBy, uploadedAt }`.

### Serve handler invariants

1. Path-regex match — anything that doesn't match the canonical `<ts>-<uuid>.<ext>` shape is 400.
2. Query params `t`, `exp`, `u` are required. Missing → 400.
3. `exp < now` → 410 Gone. Signature verify failure → 403. Both come *before* any disk read.
4. Capability check — the named plugin must declare `storage.file:self`. Defense-in-depth: a plugin can't have files served if it doesn't claim the cap.
5. `Range` header parsing handles single-range `bytes=N-M`, `bytes=N-`, `bytes=-M`. Multi-range is 416 (rejected — not worth the complexity for v1).
6. Response sets: sniffed `Content-Type`, `nosniff`, `Cache-Control: private, immutable, max-age=3600`, `ETag` (filename is its own ETag — content-addressed via UUID), `Accept-Ranges: bytes`, `Content-Disposition: inline | attachment; filename*=UTF-8''<encoded original>`.

---

## Lifecycle

```
┌──────────┐  POST /upload      ┌─────────┐  file.uploaded IPC  ┌──────────┐
│  client  ├───────────────────▶│ runtime ├────────────────────▶│  plugin  │
│ (iframe) │ (streamed body)    │  HTTP   │                     │ backend  │
└──────────┘                    └────┬────┘                     └────┬─────┘
                                     │                               │
                                     │  201 { filename, mime, ... }  │
                                     │◀──────────────────────────────┤
                                     │                               │
                                     │  (plugin holds metadata,      │
                                     │   no DB row yet)              │
                                     │                               │
┌──────────┐ sendMessage IPC         │                          ┌────▼─────┐
│  iframe  ├─────────────────────────┼─────────────────────────▶│ plugin   │
└──────────┘ { content, attachments }│                          │ validates│
                                     │                          │ inserts  │
                                     │                          └────┬─────┘
                                     │                               │
                                     │  message.created (enriched)   │
                                     │◀──────────────────────────────┤
                                     │  with fresh signed URLs       │
                                     │                               │
┌──────────┐ GET /files/.../?t=...   │                               │
│  client  ├────────────────────────▶│                               │
│ <img src>│                         │  verify sig + Range stream    │
└──────────┘◀────────────────────────┤                               │
                                     │                               │
                                     │  ... 1 hour later ...         │
                                     │                               │
                                     │  hourly GC sweep              │
                                     │◀──────────────────────────────┤
                                     │  plugin.files.list + delete   │
                                     │  orphans                      │
```

---

## Multi-Environment URL Handling

The portable-server model means a single server's public URL can change in three ways:

1. **`try.cloudflare.com` ephemeral.** Hostname flips on every runtime restart. Heartbeat re-publishes; clients reconnect to the new URL.
2. **Permanent named tunnel.** Stable hostname for the life of the server.
3. **Private invites (future).** Specific URLs handed to specific users, may differ per invite recipient.

The path-only stored URL scheme handles all three uniformly. The client always knows the URL it connected through — that's the URL it prepends. No re-write, no migration, no broken history.

---

## Streaming and Performance

### Memory profile per upload

`O(64 KB)` per concurrent upload (Bun's default chunk size). 1 000 concurrent 5-GB uploads pin 64 MB of process memory, not 5 TB. The chunked path (Amendment A) holds the same per-connection profile — each `PATCH` is a separate HTTP request that streams its body to disk.

### Disk write pattern

Single sequential write to `.tmp`, atomic rename on success. No fsync — the OS flushes within seconds; an unclean container halt loses the last few seconds of writes, same posture as the SQLite WAL.

### Serve memory profile

`O(64 KB)` per concurrent serve. Range-stream from `Bun.file(path).slice(start, end+1).stream()`.

### Hot-path optimizations

- Signed-URL verify is HMAC-SHA256 over a short string: ~5 µs per request.
- Magic-byte sniffer reads the first 16 KB only; sniffing happens on the same buffer the disk write consumes.
- ETag comparison short-circuits `304 Not Modified` for repeat fetches.

---

## Settings Recipe

text-channels is the first consumer; the spec defines the canonical setting shape so other plugins copy it verbatim. Future plugins offering uploads should declare exactly the three settings shown in §"Plugin Contract" above (key names and stop values fixed). This gives server owners one consistent control surface across plugins — they learn it once.

---

## Phase Scope

Phase 1.5 (shipped):

- Runtime: streaming upload, signed-URL serve, signing module, 1-GB ceiling.
- text-channels: schema migration, three settings, attachment send/edit/render, orphan GC.
- Plugin SDK frontend: upload helper with progress.
- Plugin SDK backend: `plugin.files.stat/signUrl/delete/list`.

Phase 1.5+ (Amendment A — chunked resumable uploads):

- Runtime: `/upload/init` + `/upload/<id>` PATCH/GET/DELETE + `/upload/<id>/finalize`, sidecar `meta.json` per session, periodic GC sweep of expired in-progress uploads.
- Ceiling: 1 GB → 5 GB.
- Plugin SDK frontend: internal dispatch between single-shot (≤50 MB) and chunked (>50 MB); same public `upload()` signature.
- text-channels: manifest `attachments_max_bytes` default 5 GB; tray UX reports MB/GB scale + "Resuming…" indicator.

Phase 2 candidates (deferred):

- Per-server disk quota config (currently: unlimited, runtime warns at 90% host disk).
- Per-user upload quota.
- Content scanning hook (`plugin.files.scan(filename)` invoking a server-installed scanner plugin).
- Multi-range responses.
- Cross-plugin file references (Gallery plugin pulls from text-channels uploads). Requires a capability and a serve-side cross-plugin auth check.
- Parallel chunked uploads (sequential is shipped in Amendment A; parallel would need a chunk-bitmap and random-access writes).
- Client-side persistent resume across page reload (server keeps partials for 24h; v1 client only resumes within the same tab).

---

## Future Refinements

- **Persistent signing secret with rotation.** Currently boot-only. Persisted secret with overlap-window rotation would let cached client URLs survive a runtime restart, reducing refetch chatter. Not worth the disk-secret surface in v1; revisit when restart frequency becomes painful.
- **Resumable uploads.** ~~A 1-GB upload over a flaky mobile link is fragile.~~ Shipped in Amendment A — chunked + resumable up to 5 GB.
- **CDN offload.** Some server owners may want hot attachments fronted by Cloudflare's CDN. Compatible with signed URLs but adds an origin-pull config dance. Deferred.
- **Custom file MIME detector plugins.** Lets plugins extend the sniff table for domain-specific formats (.minecraft .level files, etc.). Speculative.

---

## Impact on Existing Docs

- `spec-04-plugin-architecture.md` — `storage.file:self` capability description now covers serve-side gating, not just upload.
- `spec-05-plugin-data-model.md` — note the canonical `Attachment` wire shape.
- `spec-09-client-apps.md` — client-side responsibility to prepend its known server origin to path-only URLs.
- `status-open-questions.md` line 86 — partially resolved (file uploads no longer a plugin-config open question; the recipe is locked here).

---

## Relationship to Other Docs

- **spec-03 (server container)**: attachments share the plugin's data volume; backup story is identical.
- **spec-04 (plugin architecture)**: this spec is the concrete contract for the `storage.file:self` capability.
- **spec-06 (authentication)**: signed URLs are a parallel auth channel for static asset serving; JWT auth still gates the upload endpoint.
- **spec-09 (client apps)**: client responsibility to construct full URLs from path-only stored references.

---

## Amendment A — Chunked Resumable Uploads

*Status: shipped Phase 1.5+. Adds a chunked + resumable upload path so multi-GB transfers survive transient network failures; raises the runtime hard ceiling to 5 GB.*

### Motivation

The single-shot streamed `POST /upload` works, but is fragile at multi-GB scale. A dropped Wi-Fi packet at byte 4 GB forces the user to start over from byte 0; a Cloudflare Tunnel idle timeout mid-upload silently 502s; a runtime restart mid-upload abandons the `.tmp` file. The 1 GB ceiling exists partly to limit the blast radius of each failure mode.

Users on home networks pushing screen-recording exports, game saves, and mod packs want to feel that "5 GB" actually works. The chunked path gives them that.

### Design

#### Endpoint family

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/upload/init` | Reserve a new `upload_id`; returns `chunk_size`, `expires_at`, `received_bytes: 0` |
| `PATCH` | `/upload/<id>?offset=N` | Append one chunk at byte offset `N` |
| `GET` | `/upload/<id>` | Return `{received_bytes, total_bytes, expires_at}` — used by client to resync after a disconnect |
| `POST` | `/upload/<id>/finalize` | Validate received_bytes == total_bytes, magic-byte sniff full head, atomic-rename into `uploads/<final>`, return same envelope as `POST /upload` |
| `DELETE` | `/upload/<id>` | Cancel + delete partial |
| `POST` | `/upload` (unchanged) | Single-shot fast path — preserved for files ≤ `SINGLE_SHOT_THRESHOLD` |

All endpoints share the existing auth surface: `Authorization: Bearer <JWT>`, `X-Plugin: <slug>`, capability gating on `storage.file:self`, per-user rate limiting via `RATE_UPLOAD`.

#### Wire format

**`POST /upload/init`**
```json
Request
{
  "original_name": "<RFC-5987 string>",
  "total_bytes":   5368709120,
  "mime_hint":     "video/mp4"
}

Response 201
{
  "upload_id":      "<URL-safe slug, ≥128 bits of entropy>",
  "chunk_size":     8388608,
  "received_bytes": 0,
  "expires_at":     1715715600
}
```

**`PATCH /upload/<id>?offset=N`** — body is raw bytes of the chunk, `Content-Length` required. Returns `204 No Content` on append.

**`GET /upload/<id>`**
```json
Response 200
{ "received_bytes": 67108864, "total_bytes": 5368709120, "expires_at": 1715719200 }
```

**`POST /upload/<id>/finalize`** — empty body. Returns the same `{ ok, filename, size, mime, originalName, width?, height?, duration? }` envelope as `POST /upload` so callers don't need a separate response parser.

#### Locked numbers

- `SINGLE_SHOT_THRESHOLD = 50 MB` (52 428 800 bytes) — SDK boundary between paths.
- `CHUNK_SIZE = 8 MB` (8 388 608 bytes) — server-picked default; returned by `/init` so the server can tune later without an SDK rev.
- `HARD_UPLOAD_CEILING = 5 GB` (5 368 709 120 bytes) — both paths.
- `UPLOAD_SESSION_TTL = 24 h` from last activity. Each `PATCH` extends `expires_at`.
- `CHUNK_RETRY_ATTEMPTS = 5` per chunk (SDK side), exponential backoff `1s, 2s, 4s, 8s, 16s` capped at 16s.

#### Storage layout

```
<plugin.dataDir>/
  uploads/                      # unchanged — finalized files
  uploads.in_progress/          # NEW — one subdirectory per session
    <upload_id>/
      data                      # append-only chunk bytes
      meta.json                 # session metadata, see below
```

`meta.json` shape:

```ts
interface UploadSessionMeta {
  upload_id:      string;
  plugin_slug:    string;
  user_id:        string;
  original_name:  string;        // RFC-5987 decoded
  total_bytes:    number;
  received_bytes: number;
  mime_hint:      string;        // from /init body; not trusted at finalize
  head_b64:       string;        // first 64 bytes of `data`, base64; used for magic-byte sniff on finalize
  created_at:     number;        // unix-ms
  expires_at:     number;        // unix-seconds — sweepable when < now
}
```

**Atomic meta writes.** Each state mutation writes `meta.json.tmp`, `fsync`, then renames to `meta.json`. Reads never observe a half-written file.

**Per-session serialization.** Concurrent `PATCH` requests for the same `upload_id` would race the read-modify-write on `meta.json` and the append on `data`. The runtime serializes them via an in-memory `Map<upload_id, Promise>` mutex — second arrival awaits the first to complete, identical to the WS connect-dedup pattern. If a client mistakenly fires two PATCHes in parallel, the second sees the post-first state and `409 RANGE_CONFLICT`s (its `offset` is now less than `received_bytes`).

#### Idempotency & resume

| Condition | Server response |
|---|---|
| `offset == received_bytes` (and body bytes fit within `total_bytes`) | `204 No Content`, append, advance `received_bytes`, extend `expires_at` |
| `offset < received_bytes` | `409 RANGE_CONFLICT` — client lost sync; recover via `GET /upload/<id>` |
| `offset > received_bytes` | `416 RANGE_NOT_SATISFIABLE` — gap not allowed; recover via `GET /upload/<id>` |
| `offset + chunk_len > total_bytes` | `413 PAYLOAD_TOO_LARGE` — chunk would overshoot declared total |
| `expires_at < now` on any op | `410 GONE`, session deleted (or queued for sweep) |
| JWT user mismatch with `meta.user_id` | `403 FORBIDDEN` |
| Plugin slug header mismatch with `meta.plugin_slug` | `403 FORBIDDEN` |

The client's recovery loop is: on any transient PATCH failure (network error, timeout, 5xx), wait per backoff schedule, `GET /upload/<id>`, retry PATCH from the authoritative `received_bytes`. After `CHUNK_RETRY_ATTEMPTS` consecutive failures of the same chunk, surface `NETWORK_ERROR` (or `RANGE_CONFLICT` if the resync itself failed).

#### Finalize semantics

`POST /upload/<id>/finalize`:

1. Validate `received_bytes == total_bytes`. If not, `400 LENGTH_MISMATCH`.
2. Re-read `head_b64` (or the first 64 bytes of `data`) and run `sniffMime()` from `runtime/src/http/mime-sniff.ts`. Sniffed MIME wins over `mime_hint`.
3. Compute final filename `${Date.now()}-${crypto.randomUUID()}<ext>` where `<ext>` derives from sniffed MIME.
4. Atomically rename `uploads.in_progress/<id>/data` → `uploads/<final>`.
5. Best-effort delete `uploads.in_progress/<id>/`.
6. Emit `file.uploaded` IPC to the plugin (same payload shape as single-shot path).
7. Return `201 { ok, filename, size, mime, originalName, ... }`.

Atomic-rename is the commit point. If the rename succeeds but the cleanup fails, the next GC sweep handles the orphan directory.

#### GC

`runtime/src/http/handler.ts:sweepStaleUploadTmps()` extends to also walk `uploads.in_progress/*` for each plugin's `dataDir`. For each subdirectory:

- Read `meta.json`. If parse fails or `expires_at < now`, delete the whole subdirectory.
- If no `meta.json` exists (orphan from a crashed init), delete after `INPROGRESS_GRACE = 1 h` based on directory mtime.

The sweep runs at runtime boot (existing call site) and additionally every 60 minutes thereafter (new periodic schedule). The existing 10-minute `.tmp` stale threshold for single-shot uploads is unchanged.

#### SDK behaviour

`packages/plugin-sdk-frontend/src/files.ts` public surface is unchanged. The internal dispatch:

```ts
async function upload(file, opts) {
  await preflight(file, opts);                 // unchanged
  if (file.size <= SINGLE_SHOT_THRESHOLD) {
    return uploadSingleShot(file, opts);       // existing XHR path
  }
  return uploadChunked(file, opts);            // new
}
```

`uploadChunked()`:
1. `POST /upload/init` via `fetch` (no progress needed for the small body).
2. Loop: for each offset `N` in `[0, chunk_size, 2*chunk_size, ...]`, send `PATCH /upload/<id>?offset=N` with `file.slice(N, N + chunk_size)` via XHR. Use `xhr.upload.onprogress` to aggregate `loaded = N + chunk_loaded` and `total = file.size`.
3. On transient error: backoff, `GET /upload/<id>` to resync, retry. On permanent error (401/403/410/413/415/422): reject.
4. After last chunk: `POST /upload/<id>/finalize` via `fetch`. Resolve with the returned `UploadResult`.

New error codes:
- `UPLOAD_EXPIRED` (server 410)
- `RANGE_CONFLICT` (server 409 with resync also failing)
- `INTEGRITY_FAILED` (server-side sniff at finalize rejects the file)

New option: `onRetry?: (attempt: number) => void` — fires when a chunk is being retried, so the tray can show "Resuming…".

`AbortSignal` aborts the in-flight chunk XHR and best-effort fires `DELETE /upload/<id>`.

### Threat model additions

- **Stuffing the in-progress dir.** A user could call `/upload/init` repeatedly without ever PATCHing, filling the directory. Mitigation: `RATE_UPLOAD` already caps `/upload/init`; GC sweeps abandoned (init-without-data) sessions after 1 h.
- **Wrong-user chunk replay.** A leaked `upload_id` would let an attacker append data the victim then commits. Mitigation: every op binds the request's JWT `user_id` against `meta.user_id`; mismatch is 403. Replay across a logout-login window with the same user is acceptable (same threat posture as the existing signed-URL leakage window).
- **MIME spoofing via the chunked path.** Same defense as single-shot: magic-byte sniff at finalize over the first 64 bytes, `nosniff`, `attachment` default for unknown types. The `mime_hint` from `/init` is logged but not trusted.
- **TOCTOU on finalize.** Between magic-byte sniff and atomic rename, the file could in theory be replaced by a colluding actor with disk access. Out of scope — the threat model already accepts disk-level compromise.

### Backward compatibility

The existing `POST /upload` endpoint, signing module, serve handler, plugin SDK backend (`plugin.files.{stat,signUrl,delete,list}`), and `Attachment` wire shape are all unchanged. text-channels' `sendMessage` handler accepts the same `{filename, original_name, mime, size}` payload — whether the file was uploaded single-shot or chunked is invisible to it.

Older SDKs (without the dispatch logic) continue to work via the single-shot path up to 5 GB. The chunked path is a strict additive improvement.

### Verification

- Unit tests in `runtime/src/http/upload-session.test.ts`: init → PATCH × N → finalize happy path; resume via `GET` after simulated disconnect; 409/416 offset semantics; 410 on expired session; 403 on wrong user; integrity sniff at finalize; concurrent-PATCH mutex; GC of expired sessions.
- Unit tests in `packages/plugin-sdk-frontend/src/files.test.ts`: chunked-path dispatch boundary at exactly 50 MB; 3-chunk happy path; transient error → resync → retry; abort mid-chunk fires DELETE; exponential backoff cap; 410 surfaces `UPLOAD_EXPIRED`.
- Integration test in `runtime/src/text-channels.test.ts`: 60 MB upload routes through chunked path, sends message, attachment renders.
- Manual E2E on `dev.24`: 4 GB upload end-to-end, Wi-Fi blip resume on 500 MB, single-shot path for 50 KB image, cancel mid-upload.

### Impact on existing locked decisions

- **"Runtime hard cap = 1 GB"** → updated to 5 GB (see Locked Decisions §).
- **"One runtime upload endpoint: `POST /upload`"** → updated to "one endpoint family" with two paths.
- **`attachments_max_bytes` stops** → adds a 5 GB stop; default raises to 5 GB.
- **Future Refinements "Resumable uploads (TUS)"** → marked shipped (custom protocol, not TUS — TUS interop was unnecessary since plugins are first-party).
