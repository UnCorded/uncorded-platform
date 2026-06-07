---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Local-first, user-owned data"
depends-on: [spec-02-system-overview, spec-03-server-container, spec-04-plugin-architecture]
last-verified: 2026-04-05
---

# 12 — Data Flow

*How messages, files, and events actually move through the system. Why everything is server-side. Why there is no P2P.*

---

## The Rule

**All data flows through the server container.** There is no peer-to-peer. There is no client-to-client. There is no Central relay. Every message, file, voice packet, and event goes from the user to the server, and from the server to other users. The server is the single source of truth.

---

## Message Flow (Text)

A user sends a message in a text channel:

```
[1] User types message in plugin iframe (text-channels frontend)
[2] Frontend calls: sdk.request("sendMessage", { channelId, content })
[3] Shell intercepts, tags with plugin slug, sends over WebSocket to server
[4] Runtime receives, validates auth + capability, routes to text-channels subprocess
[5] text-channels backend:
    - Validates content (length, rate limit)
    - Inserts into messages table (own SQLite)
    - Publishes event: text-channels.message.created
[6] Runtime distributes event to:
    - All connected users subscribed to this topic → WebSocket push
    - Any other plugin backends subscribed to this topic → IPC
[7] Each user's shell routes the event to the text-channels iframe
[8] text-channels frontend renders the new message
```

**Total hops:** user → server → users. One hop in, fan-out on the server. Central is not involved.

---

## File Upload Flow

A user uploads a photo in a gallery plugin:

```
[1] User selects file in plugin iframe (photo-gallery frontend)
[2] Frontend calls: sdk.upload(file, { album: "vacation" })
[3] Shell sends HTTP POST to /upload with:
    - Bearer token in Authorization header
    - X-Plugin: photo-gallery
    - File as multipart/form-data
[4] Runtime receives, validates auth + capability (storage.file:self)
[5] Runtime saves file to /data/uploads/photo-gallery/<file-id>
[6] Runtime notifies photo-gallery backend via IPC: "file uploaded"
[7] photo-gallery backend:
    - Records file metadata in own SQLite (filename, size, album, uploader)
    - Publishes event: photo-gallery.photo.uploaded
[8] Runtime distributes event to connected users
[9] Other users' photo-gallery frontends render the new photo
```

**The file lives on the server owner's disk.** It does not pass through Central. It is not uploaded to cloud storage. It is not shared peer-to-peer. It sits in `/data/uploads/photo-gallery/` on the owner's machine.

---

## Real-Time Event Flow

Events power live updates across all connected users:

```
[1] Something happens in a plugin backend (new message, user joined, photo uploaded)
[2] Backend publishes event via IPC: sdk.events.publish("topic", payload)
[3] Runtime receives event, checks publish capability
[4] Runtime distributes to all subscribers:

    For plugin backends (IPC):
      → Runtime sends event via stdio IPC (JSON over the plugin's stdin)
      → Backend's sdk.events.subscribe handler fires

    For connected users (WebSocket):
      → Runtime checks which connected users are subscribed to this topic
      → Sends event over each user's WebSocket
      → Shell routes event to the correct plugin iframe
      → Frontend's sdk.subscribe handler fires
```

**Events are fire-and-forget from the publisher's perspective.** The runtime handles fan-out. The publisher doesn't know or care how many subscribers there are.

---

## Cross-Plugin Data Read Flow

An extension plugin reads data from a base plugin:

```
[1] reactions frontend needs to show reactions for a message
[2] Frontend calls: sdk.request("getReactions", { messageId })
[3] reactions backend handles the request:
    - Queries own SQLite for reactions on this message
    - Needs the message content for display context
    - Calls: sdk.data.read("text-channels", "messages")
        .where("id", "=", messageId)
        .select(["id", "content", "author_id"])
        .exec()
[4] SDK sends structured query to runtime via IPC
[5] Runtime checks:
    - Does reactions have data.read:text-channels.messages capability? ✓
    - Are id, content, author_id in text-channels' public_schema? ✓
[6] Runtime opens read-only connection to text-channels.db
[7] Runtime executes query, returns results to reactions backend
[8] reactions backend combines own reaction data with message context
[9] Returns combined result to frontend
```

**No raw SQL crosses plugin boundaries.** Cross-plugin reads go through the runtime, which enforces published schema visibility and logs the access.

---

## Cascade Flow (User Deletion)

When a user is deleted or banned, data cleanup spans all plugins:

```
[1] Server owner bans user via admin panel or members plugin
[2] Runtime emits: runtime.cascade.user.deleted { user_id, cascade_id }
[3] Each plugin with a cascade subscription handles cleanup independently:

    text-channels:
      → DELETE FROM messages WHERE author_id = ?
      → DELETE FROM message_edits WHERE author_id = ?
      → Reports success to runtime

    reactions:
      → DELETE FROM reactions WHERE user_id = ?
      → Reports success to runtime

    photo-gallery:
      → DELETE FROM photos WHERE uploader_id = ?
      → Deletes files from /data/uploads/photo-gallery/ for this user
      → Reports success to runtime

[4] Runtime tracks per-plugin completion status
[5] If all succeed → cascade marked complete in audit log
[6] If any fail → failure logged to pending cascades panel, admin can retry
```

**Cascades are async, best-effort, visible.** Not atomic, not silent. See `spec-05-plugin-data-model.md` for the full cascade spec.

---

## What Does NOT Flow Through the System

| Data | Why it doesn't flow |
|---|---|
| Messages through Central | Central is auth + directory only. Messages go user → server → users. |
| Files through Central | Files are uploaded to the server container's disk. Central never sees them. |
| Files peer-to-peer | No P2P. No WebTorrent. All files go through the server. The server is the single source of truth. |
| Voice through Central | Voice (Phase 2) will use WebRTC with the server as SFU. Audio packets go user → server → users. Central is not involved. |
| Plugin data to Central | Plugin databases are per-plugin SQLite files on the server. Central cannot read them. |
| User content in heartbeats | Heartbeats carry: tunnel URL, runtime version, user count, sync version. Never message content, file content, or plugin data. |

---

## Why No P2P

The previous UnCorded architecture used WebTorrent for peer-to-peer file transfer. The new architecture explicitly removes P2P. Here's why:

1. **Simplicity.** One data path (user → server → users) instead of two (server for messages, P2P for files). One path to secure, one path to debug, one path to monitor.
2. **Reliability.** P2P requires both users to be online simultaneously. Server-side storage means files are available whenever the server is running, even if the uploader is offline.
3. **Privacy model clarity.** "Your data lives on the server owner's hardware" is a clear, simple statement. "Your data lives on the server owner's hardware, except files which bounce between users directly" is confusing and harder to reason about.
4. **NAT traversal complexity removed.** P2P requires STUN/TURN servers for users behind NATs. That's infrastructure Central would have to operate, which contradicts "Central is lightweight."
5. **The server is already there.** The user is already running a Docker container with disk space and a public URL. Using it for file storage is the simplest possible design.

**The tradeoff accepted:** files consume disk space on the server owner's machine. A busy server with many uploaded photos or documents will use more storage. This is acceptable because:
- The server owner chose to run the server on their hardware. They control the disk.
- Per-plugin disk quotas (see `spec-04-plugin-architecture.md`) prevent any single plugin from consuming unbounded space.
- Backup is just copying the `/data/` volume.

---

## Summary

| Question | Answer |
|---|---|
| How do messages flow? | User → server (WebSocket) → other users (WebSocket fan-out) |
| How do files flow? | User → server (HTTP upload) → stored on server disk → served to other users on request |
| How do events flow? | Plugin backend → runtime event bus → subscribed backends (IPC) + subscribed frontends (WebSocket) |
| How do cross-plugin reads work? | Extension → runtime (structured query) → base plugin's DB (read-only) → results back to extension |
| Does anything go through Central? | No. Only heartbeats (metadata) and auth tokens. Never user content. |
| Is there P2P? | No. Explicitly removed. Everything is server-side. |
| Where does data live? | On the server owner's hardware in per-plugin SQLite files and the `/data/uploads/` directory. |
| What happens when the server is offline? | **All data is inaccessible until the server restarts.** Messages, files, and plugin data are not lost — they are on disk — but no user can read them while the container is not running. |

---

## Server Offline = Messages Inaccessible

This is a fundamental tradeoff of the self-hosted model and must be stated plainly.

All data lives on the server owner's hardware. When that hardware is off — or the Docker container is stopped — messages are inaccessible to everyone. Not lost. Not deleted. Just unavailable until the server restarts. There is no ambient availability. If your friend messages you at 3am while your PC is off, you won't see it until you turn your machine on.

This is most noticeable in the "two friends use a server for DMs" scenario. Unlike Discord or iMessage, where messages are always available because a centralized server is always running, UnCorded messages exist only on the hosting machine.

**This is a known cost of the architecture, not an oversight.**

### Mitigation paths

1. **Many homelab users run hardware 24/7 anyway.** A NAS, a Raspberry Pi, a spare PC left on — these are always-on by nature. The "server is offline" problem only hits desktop-PC hosts who shut down their machine at night.
2. **A cloud VPS is $5/month.** A user who wants always-on availability runs their container on a VPS (DigitalOcean, Hetzner, Fly.io). It's just a Docker container — it runs anywhere. This is not UnCorded's problem to solve; it's a hosting decision the owner makes.
3. **Managed hosting (post-launch)** eliminates this entirely. UnCorded runs the container on always-on infrastructure. The user gets ambient availability without self-hosting.

### What this means for the "no DMs" decision

The "spin up a two-person server for DMs" answer is architecturally clean. But the consequence — your DMs are inaccessible when the host's machine is off — is the real cost. This is acceptable for the Phase 1 audience (homelab users with always-on hardware) and mitigated for everyone else by managed hosting in the long term.

---

## Future Refinements

### CDN-backed file serving for large public servers
- **What changes:** A public server with thousands of users could optionally serve uploaded files through a CDN (e.g., Cloudflare R2 or similar) instead of directly from the container's disk, reducing bandwidth on the owner's residential connection.
- **Why not now:** Phase 1 servers are small communities. Direct file serving from the container is sufficient. CDN integration adds configuration complexity and potentially cost.
- **What today's code must not do:** The file serving path must not hardcode "read from local disk." Use an abstraction (`FileStore` interface with `get`, `put`, `delete`) so a CDN-backed implementation can be swapped in without changing plugin code or the upload endpoint.

### CDN-backed plugin frontend asset delivery
- **What changes:** Plugin frontend static assets (JS, CSS, images) could be served from Central's CDN or a third-party CDN instead of from each server container. Since plugin assets are unauthenticated by default (they're code, same for everyone), CDN delivery is straightforward — no auth tokens needed for static files.
- **Why not now:** Phase 1 servers are small communities. Direct serving from the container is sufficient. The unauthenticated-assets change (made in this session) is the prerequisite that makes CDN delivery possible.
- **What today's code must not do:** Plugin frontend assets must be served through a function (`servePluginAsset`) that can be redirected to a CDN URL without changing the shell's iframe `src` construction. The shell should load plugins via a URL the runtime provides (which could point at the local container or a CDN), not by hardcoding the tunnel URL + `/plugins/<slug>/ui/`.

### Streaming / chunked file uploads for large files
- **What changes:** Large file uploads (video, datasets) could be uploaded in chunks with resume capability, instead of a single multipart POST.
- **Why not now:** Phase 1 file uploads are photos, documents, small assets. Single-POST upload is sufficient.
- **What today's code must not do:** The `/upload` endpoint must return a `file_id` immediately on receipt. Plugins must reference files by ID, not by path. This allows the upload mechanism to change (chunked, resumable, CDN-direct) without affecting how plugins reference the file.

### End-to-end encryption for sensitive servers
- **What changes:** Messages and files could be encrypted client-side before reaching the server. The server stores ciphertext it cannot read. Only members with the decryption key can read the content.
- **Why not now:** E2E encryption fundamentally changes the data model — search, moderation, content preview, and cascade deletion all become harder or impossible. The trust model today ("the server owner is trusted with the data on their hardware") is sufficient for Phase 1.
- **What today's code must not do:** The message payload format must be a bag of bytes from the runtime's perspective, not a parsed structure. The runtime routes messages — it should not need to read message content. If the payload is always opaque to the runtime, E2E encryption becomes "encrypt before send, decrypt after receive" without any runtime changes.
