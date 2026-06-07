---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Local-first, user-owned data"
depends-on: [spec-04-plugin-architecture]
last-verified: 2026-04-05
---

# 05 — Plugin Data Model

*How plugins store data, how they access each other's data, how schemas evolve, and how cross-plugin operations like user deletion work.*

---

## Core Rule

**Every plugin owns its own SQLite database file.** A plugin can only write to its own file. No plugin can write to another plugin's database, ever. This is the foundation of plugin isolation — a compromised or buggy plugin cannot corrupt another plugin's data.

```
/data/plugins/
├── text-channels.db     ← owned by text-channels, only text-channels can write
├── reactions.db         ← owned by reactions, only reactions can write
├── members.db           ← owned by members, only members can write
└── photo-gallery.db     ← owned by photo-gallery, only photo-gallery can write
```

SQLite runs in **WAL mode** (Write-Ahead Logging) by default for every plugin database. WAL allows concurrent reads without blocking writers, which matters when the runtime mediates cross-plugin reads while the owning plugin is actively writing.

---

## Querying Your Own Database

Plugins have **full raw SQL access** to their own database. No abstraction layer, no query builder, no restrictions. The SDK provides a thin typed wrapper around SQLite:

```ts
// Insert
db.run(
  "INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
  [id, channelId, authorId, content, Date.now()]
)

// Query
const messages = db.query<Message>(
  "SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?",
  [channelId, 50]
)

// Transaction
db.transaction(() => {
  db.run("UPDATE messages SET content = ? WHERE id = ?", [newContent, messageId])
  db.run("INSERT INTO message_edits (message_id, old_content, edited_at) VALUES (?, ?, ?)",
    [messageId, oldContent, Date.now()])
})
```

**Why raw SQL:** every developer knows SQL. A query builder is an abstraction they have to learn that can never be as flexible as the real thing. The plugin owns the database — there is no reason to restrict what it can do with its own data.

**Transactions** work as normal SQLite transactions within a single plugin's database. Cross-plugin transactions do not exist — each database is a separate file with a separate lock. This is a deliberate constraint, not a limitation to work around.

---

## Published Schema (Cross-Plugin Reads)

**All plugin data is private by default.** No other plugin can see any table or column unless the owning plugin explicitly publishes it.

A plugin declares its published schema in the manifest:

```json
{
  "name": "text-channels",
  "version": "1.0.0",
  "public_schema": {
    "messages": {
      "columns": ["id", "channel_id", "author_id", "content", "created_at"],
      "description": "All messages across all channels in this server."
    },
    "channels": {
      "columns": ["id", "name", "topic", "created_at"],
      "description": "All text channels in this server."
    }
  }
}
```

**What `public_schema` means:**

- These columns are **guaranteed stable** within a major version. Removing or renaming a published column is a breaking change that requires a major version bump.
- Internal columns (e.g., `search_tokens`, `internal_flags`) are **not listed** and are invisible to other plugins.
- Internal tables (e.g., `message_drafts`, `rate_limit_state`) are **not listed** and are invisible to other plugins.
- If a plugin has no `public_schema` section, it exposes nothing. Zero access is the default.

**This is a contract.** A plugin with a published schema is saying: "extensions can depend on these columns existing and having stable types. Everything else is mine and may change without notice."

---

## Cross-Plugin Read API

An extension plugin that needs to read from another plugin's data declares the capability in its manifest:

```json
{
  "name": "reactions",
  "extends": "text-channels",
  "permissions": [
    "data.read:text-channels.messages"
  ]
}
```

At runtime, the extension uses the **structured read API** — not raw SQL:

```ts
// Read messages from text-channels (cross-plugin)
const messages = await sdk.data.read("text-channels", "messages")
  .where("channel_id", "=", channelId)
  .select(["id", "content", "author_id", "created_at"])
  .orderBy("created_at", "desc")
  .limit(50)
  .exec()
```

**What happens under the hood:**

1. The SDK sends the structured query to the runtime over the plugin's IPC socket.
2. The runtime checks: does `reactions` have the `data.read:text-channels.messages` capability? If not → reject.
3. The runtime checks: are all requested columns in `text-channels`' `public_schema.messages.columns`? If any are not → reject.
4. The runtime opens a **read-only connection** to `text-channels.db` and executes the query.
5. Results are returned to `reactions` over IPC.
6. The query is logged for audit purposes.

**Why structured queries instead of raw SQL for cross-plugin reads:**

- The runtime must enforce which columns are visible (published schema).
- The runtime must prevent expensive operations (full table scans, joins against unpublished tables).
- The runtime must audit cross-plugin access for observability.
- Raw SQL would bypass all three guarantees.

**Performance:** cross-plugin reads go through IPC and the runtime, so they are slower than direct SQL against your own database. For hot paths (e.g., rendering reactions on every message in a busy channel), plugins should cache cross-plugin data locally and subscribe to events for invalidation, rather than querying on every render.

---

## Schema Migrations

Plugins manage their own database schemas through **numbered SQL migration files.** The runtime handles execution — guaranteeing each migration runs exactly once, in order, atomically.

### How it works

A plugin ships a `migrations/` directory:

```
plugins/text-channels/
├── manifest.json
├── migrations/
│   ├── 001_create_tables.sql
│   ├── 002_add_edited_at.sql
│   └── 003_add_thread_support.sql
├── backend/
└── frontend/
```

Each file is a plain SQL script:

```sql
-- 002_add_edited_at.sql
ALTER TABLE messages ADD COLUMN edited_at INTEGER;
```

### What the runtime does on plugin load

1. Opens the plugin's database file (creates it if it doesn't exist).
2. Checks the `_migrations` table (auto-created by the runtime) for the highest completed migration number.
3. Finds any migration files with a higher number.
4. Runs each one in order, inside a transaction.
5. Records the migration number and timestamp in `_migrations` after each succeeds.
6. If any migration fails, the transaction rolls back and the plugin fails to load. The error is surfaced in the server admin UI.

### Rules

- Migration files are **immutable once shipped.** Never edit a migration that has already run on any server. Write a new migration file instead.
- Migration numbers must be **sequential with no gaps.** The runtime rejects a plugin with `001, 003` (missing `002`).
- Migrations run **before the plugin backend starts.** The database is always at the latest schema when plugin code first runs.
- The runtime provides no "down" migration. Rollback is a new forward migration that reverses the change. This is simpler and safer than bidirectional migrations.

### Published schema and migrations

When a migration adds a column that should be visible to extensions, the `public_schema` in the manifest is updated in the same plugin release. The runtime validates that every column listed in `public_schema` actually exists in the database after migrations run — if a published column is missing, the plugin fails to load.

---

## Cross-Plugin Cascades

When an operation needs to span all plugins — like deleting all data for a banned user — the runtime coordinates via **cascade events.**

### How it works

1. A server owner bans a user or a user requests data deletion.
2. The runtime emits a cascade event to every installed plugin:

```
Event: runtime.cascade.user.deleted
Payload: { user_id: "abc123", requested_by: "server_owner", timestamp: 1712345678 }
```

3. Every plugin that stores user-scoped data subscribes to cascade events and handles its own cleanup:

```ts
sdk.events.subscribe("runtime.cascade.user.deleted", async (event) => {
  db.run("DELETE FROM messages WHERE author_id = ?", [event.payload.user_id])
  db.run("DELETE FROM message_edits WHERE author_id = ?", [event.payload.user_id])
})
```

4. Each plugin reports success or failure back to the runtime.

### Cascade types

| Event | When it fires | What plugins should do |
|---|---|---|
| `runtime.cascade.user.deleted` | User is banned or deleted from the server | Delete or anonymize all data for that user |
| `runtime.cascade.user.export` | User requests a copy of their data (GDPR) | Return a JSON/ZIP of all user-scoped data to the runtime, which bundles it |
| `runtime.cascade.server.reset` | Server owner resets the server to a clean state | Delete all user-generated data, preserve config |

### Failure handling

- Cascades are **async and best-effort per plugin.** Each plugin handles the event independently.
- If a plugin fails (crashes, times out, throws), the failure is **logged to a pending cascades panel** in the server admin UI.
- The admin can see exactly which plugin failed for which cascade, and **retry** the failed cascade for that specific plugin.
- Cascades are **not atomic.** Three plugins might succeed while one fails. The admin sees the partial state and decides what to do.
- The cascade event follows the same backpressure rules as all events — the default overflow policy is `mark_unhealthy`, not silent drop.

### Why not atomic?

Atomic cross-plugin operations would require a shared database or a two-phase commit protocol. Both would compromise plugin isolation — the core architectural guarantee. Best-effort with visible failures is the realistic model for a plugin platform where each plugin owns its own data file.

### Handling orphaned references

When a cascade deletes data that other records reference — replies to deleted messages, reactions on deleted messages, comments on deleted photos — the cascade model handles the deletion but not the orphans.

**This is a per-plugin design decision, not a runtime concern.** The runtime fires the cascade event. Each plugin decides how to handle references to data that no longer exists.

**Recommended pattern: anonymize, don't hard-delete referenced data.**

- When `text-channels` receives `cascade.user.deleted`, it should **replace message content with "[deleted]" and author with "[deleted user]"** rather than deleting the message row entirely. Reply chains, reactions, and quotes remain intact with a visible placeholder instead of a broken reference.
- When `photo-gallery` receives `cascade.user.deleted`, it should **delete the photo files** (they contain user content) but **keep the metadata row with a "[deleted]" marker** so comments from other users aren't orphaned.
- Hard deletion of referenced data creates orphans that confuse users, break UI assumptions, and produce "message not found" errors throughout the interface.

**The guidance for plugin authors:** if your data is referenced by other plugins or by other records in your own database, prefer anonymization over hard deletion. Replace content with "[deleted]", replace author identifiers with "[deleted user]", keep the record structure intact. Reserve hard deletion for data that is never referenced (standalone uploads, session data, caches).

This guidance should be included in the Plugin SDK documentation and reinforced in the marketplace review for Verified-tier plugins.

---

## Plugin Uninstall and Data Retention

When a plugin is uninstalled:

- The plugin's database file is **kept by default.** It is not deleted. This means reinstalling the same plugin restores its data.
- The server owner can **explicitly delete** the data file from the server settings if they want a clean removal.
- **Pending cascades must complete before uninstall is allowed.** If a `user.deleted` cascade is pending for this plugin, the runtime blocks uninstall until the cascade is resolved (completed or manually dismissed by the admin). This prevents orphaned cleanup obligations.

---

## Data Backup and Restore

A server's data is the contents of `/data/`. Each plugin's database is a single SQLite file. Backup is:

```bash
# Back up the entire server's data
cp -r /data/ /backup/2026-04-05/

# Back up a single plugin's data
cp /data/plugins/text-channels.db /backup/text-channels-2026-04-05.db
```

SQLite in WAL mode requires copying both the `.db` file and the `-wal` and `-shm` files if the database is active. The runtime provides a `GET /admin/backup` endpoint that creates a consistent snapshot (calls `VACUUM INTO` or checkpoints WAL before copying) to avoid torn backups.

---

## Summary of Decisions

| Decision | Answer |
|---|---|
| Storage model | Per-plugin SQLite in WAL mode |
| Write access | Plugin-owned only. No cross-plugin writes, ever. |
| Default visibility | **Private.** All data invisible to other plugins unless explicitly published. |
| Published schema | Declared in manifest `public_schema`. Columns listed there are stable within a major version. |
| Own-DB query API | Raw SQL via `db.query()` / `db.run()` / `db.transaction()` |
| Cross-plugin read API | Structured query via `sdk.data.read()`, runtime-mediated, capability-gated |
| Schema migrations | Numbered SQL files in `migrations/`, runtime-executed exactly once in order |
| Cross-plugin cascades | Event-driven (`runtime.cascade.*`), best-effort per plugin, visible failures, admin retry |
| Data on uninstall | Kept by default, explicit delete available, pending cascades block uninstall |
| Backup | File copy with runtime-provided consistent snapshot endpoint |

---

## Future Refinements

### Cross-plugin write mediation
- **What changes:** An extension plugin could request write access to specific columns on a base plugin's table — e.g., `reactions` adding a `reaction_count` column to `text-channels.messages` to avoid N+1 queries.
- **Why not now:** The trust model for cross-plugin writes is significantly more complex than reads. A bad write can corrupt the base plugin's data. Needs real-world extension developer feedback to design the right permission granularity.
- **What today's code must not do:** The IPC protocol must not assume all cross-plugin operations are reads. Leave room in the capability grammar for `data.write:<plugin>.<table>.<column>` even though it's not implemented.

### Shared read replicas for high-traffic cross-plugin queries
- **What changes:** For hot-path cross-plugin reads (e.g., reactions on every message), the runtime could maintain a read-only replica of published schema data in a shared in-memory cache or a merged read database, eliminating IPC overhead per query.
- **Why not now:** No performance data exists. Per-plugin SQLite with IPC-mediated reads may be fast enough for Phase 1 scale. Premature optimization.
- **What today's code must not do:** The `sdk.data.read()` API must be an abstraction the runtime can reimplement without changing the plugin's code. Plugins must not assume they are hitting the raw `.db` file — the runtime can swap the backing implementation later.

### Cascade atomicity via saga pattern
- **What changes:** For compliance-critical cascades (GDPR deletion), the runtime could implement a saga coordinator that tracks per-plugin progress, handles compensating actions on failure, and guarantees eventual completion rather than best-effort.
- **Why not now:** Saga coordination is complex infrastructure. Phase 1 servers are small communities where the admin can manually retry failed cascades. The compliance use cases (HIPAA, GDPR) are Phase 2+ audience concerns.
- **What today's code must not do:** Cascade events must include a unique `cascade_id` so that a future saga coordinator can track per-plugin progress. The event schema must not assume fire-and-forget — include the ID from day one even if nothing uses it yet.

### Plugin data export as portable format
- **What changes:** A plugin's data could be exported in a standardized format (e.g., JSON-LD, SQLite dump with schema metadata) so it can be imported into another server or another platform entirely.
- **Why not now:** No standard exists for this. Designing a portable format before real-world plugin diversity exists would be guessing.
- **What today's code must not do:** Plugin data must stay in SQLite (a universally readable format), not in a proprietary binary. The data is already portable by virtue of being SQLite files — the future refinement is about adding metadata and structure, not about escaping a locked format.

### Cascades block uninstall — enforcement tightening
- **What changes:** Currently, pending cascades block uninstall. In the future, the runtime could also block plugin *updates* if the update changes the cascade handler in a way that would make pending cascades unprocessable (e.g., removing the `user.deleted` handler while cascades are pending).
- **Why not now:** Phase 1 plugins are all first-party. The risk of a plugin author removing cascade handlers mid-flight is theoretical.
- **What today's code must not do:** The runtime must track which cascade types each plugin subscribes to, not just whether cascades are pending. This metadata is needed later to detect handler removal.
