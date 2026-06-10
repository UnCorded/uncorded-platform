# Example: text-channels

`text-channels` is the canonical data-owning plugin — real-time chat with
threads, edits, deletes, file attachments, typing/viewer presence, and a
scheduled file-GC sweep. It exercises nearly every backend capability, so it's
the best single file to read after the guides. This page is an annotated tour;
the full source is
[`plugins/text-channels/backend/index.ts`](https://github.com/UnCorded/uncorded-platform/blob/main/plugins/text-channels/backend/index.ts)
(~1,200 lines).

## The manifest, decoded

```json
{
  "name": "text-channels",
  "type": "core",
  "icon": "Hash",
  "backend":  { "entry": "backend/index.ts" },
  "frontend": { "entry": "frontend/index.html" },
  "permissions": [
    "data.sql:self",
    "events.publish:text-channels.*",
    "events.subscribe:runtime.cascade.*",
    "events.subscribe:runtime.presence.*",
    "events.subscribe:text-channels.*",
    "events.subscribe:core.category.*",
    "broadcast.clients",
    "storage.file:self",
    "runtime.schedule"
  ]
}
```

Every capability traces to a feature below: `data.sql:self` → the channels/messages
DB; `events.publish:text-channels.*` → it announces its own changes;
`events.subscribe:runtime.cascade.*` → it reacts to user deletion;
`events.subscribe:core.category.*` → it nulls soft-FKs when a category is deleted;
`broadcast.clients` → live typing/viewer pushes; `storage.file:self` → attachments;
`runtime.schedule` → the orphan-GC sweep. See
[Permissions → worked example](/reference/permissions#worked-example).

It also declares a `public_schema` (so other plugins can read its `channels` and
`messages` tables), a `sidebar` contribution with `refresh_on` topics, and five
admin `settings` (max message length, edit toggle, attachment limits).

## Startup order: handlers first, async setup last

The single most important structural rule. The file does, top to bottom:

```ts
const plugin = createPlugin();

// 1. Synchronous setup that needs no IPC round-trip.
void refreshSettings();                 // fire-and-forget cache warm
plugin.settings.onChange(() => { /* re-read + push limits to clients */ });

// 2. Register EVERY handler synchronously.
plugin.handle("getChannels", …);
plugin.handle("createChannel", …);
plugin.handle("sendMessage", …);
plugin.handle("sidebar.items", …);
// … etc.

// 3. THEN await the async setup (these are IPC round-trips).
await plugin.permissions.register("text-channels.post", { default_level: 10, … });
await plugin.events.subscribe("runtime.cascade.user.deleted", …);
await plugin.events.subscribe("core.category.deleted", …);
void plugin.schedule.every("attachments.orphan_gc", ORPHAN_GC_INTERVAL_MS, sweepOrphans);
```

Handlers are registered **before** any `await`, so they exist the moment the
runtime starts routing requests. The `await`ed subscriptions/registrations come
after — they're round-trips that may not resolve until the plugin is attached.
See [Lifecycle](/guide/lifecycle#the-ready-handshake).

## Settings: cache at module scope, refresh on change {#settings}

```ts
async function refreshSettings(): Promise<void> {
  const values = await plugin.settings.getAll();
  const len = values["max_message_length"];
  if (typeof len === "number" && len >= 0) maxMessageLength = len; // 0 = "Not Guarded"
  // … allow_edits, attachment limits …
}

void refreshSettings();                       // warm at boot
plugin.settings.onChange(() => {
  void refreshSettings().then(() => {
    plugin.events.publish("text-channels.attachments.settings_updated", { … });
  });
});
```

Settings are read into module-scope variables once and refreshed when an admin
saves. Note `0` is a meaningful stored value ("unlimited"), so the guard is
`len >= 0`, not `if (len)`. After a change it re-publishes the new attachment
limits so open client trays update without a reload.

## A handler end-to-end: `sendMessage`

```ts
plugin.handle("sendMessage", async (params, user) => {
  // 1. Permission gate — application logic, not a manifest capability.
  if (!(await plugin.permissions.check(user.id, "text-channels.post"))) {
    throw new Error("Permission denied: text-channels.post");
  }

  // 2. Validate every client-supplied param. Never trust params.
  const channelId = params["channel_id"];
  const content = params["content"];
  if (typeof channelId !== "string") throw new Error("channel_id is required");
  if (typeof content !== "string")   throw new Error("content is required");
  if (maxMessageLength > 0 && content.length > maxMessageLength) {
    throw new Error("MESSAGE_TOO_LONG");
  }

  // 3. Validate attachments against the runtime's on-disk view BEFORE the write,
  //    so a row never references a missing file.
  const attachments = await validateAttachments(params["attachments"]);
  if (content.length === 0 && attachments.length === 0) throw new Error("EMPTY_MESSAGE");

  // 4. Write. Replies bump the parent's counters atomically via db.batch().
  const id = crypto.randomUUID();
  await plugin.db.batch([
    { sql: "INSERT INTO messages (...) VALUES (...)", params: [...] },
    { sql: "UPDATE messages SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?", params: [now, parentId] },
  ]);

  // 5. Enrich (join author profiles from core, sign attachment URLs), then
  //    publish to the event bus and return to the caller.
  const enriched = enrichMessage(message, memberMap, wireAttachments);
  plugin.events.publish("text-channels.message.created", enriched);
  return enriched;
});
```

The shape — **gate → validate → write → publish → return** — repeats across
`createChannel`, `editMessage`, `deleteMessage`. Two role checks appear:
`permissions.check(user.id, "text-channels.post")` for posting, and
`permissions.hasMinLevel(user.id, 60)` for moderator-only actions like creating
or deleting a channel.

## The `sidebar.items` reserved handler

The shell calls this to build the sidebar. It returns items (plus optional
admin actions), shaped by the caller's role:

```ts
plugin.handle("sidebar.items", async (_params, user) => {
  const channels = await plugin.db.query(`SELECT … FROM channels ORDER BY position ASC`);
  const isMod = await plugin.permissions.hasMinLevel(user.id, 60);

  const items = channels.map((c) => ({
    id: c.id, label: c.name, icon: "hash",
    panelType: "plugin", slug: "text-channels", section: "Chat",
    group_id: c.category_id,
    ...(isMod ? { adminActions: [ { id: "edit-channel", … }, { id: "delete-channel", … } ] } : {}),
  }));

  return isMod
    ? { items, adminActions: [{ id: "create-channel", label: "New Channel", icon: "plus" }] }
    : { items };
});
```

The manifest's `sidebar.refresh_on` lists the topics
(`text-channels.channel.created`, `…updated`, `…deleted`) that make the shell
re-call this handler — which is why creating a channel makes the sidebar update
live.

## Presence: typing & viewer counts

Presence is **scoped, ephemeral, and request-context-bound**. The `setTyping` /
`setViewingChannel` handlers `join`/`leave` a scope; a `watch` per channel pushes
the live set to the right audience via `broadcast.toUsers`:

```ts
plugin.handle("setTyping", async (params, user) => {
  if (typing) await plugin.presence.join(scope, user.id, { typing_until: Date.now() + … });
  else        await plugin.presence.leave(scope, user.id);
});

// One watcher per channel, registered at startup and on channel.created:
await plugin.presence.watch(scope, (entries) => broadcastTypingTo(viewersScope, scope, entries), { coalesceMs: 50 });
```

`join`/`leave` must run inside a request handler — they infer the WS session from
[request context](/reference/backend-sdk#request-context). The handlers also
`requireChannel(channelId)` first: presence accepts arbitrary client ids, and
without an existence check a client could spam random UUIDs to grow the watcher
registry unboundedly.

## Reacting to the runtime: cascade & soft-FK cleanup

Two subscriptions keep the plugin's data consistent with the rest of the server:

```ts
// A user was deleted anywhere → anonymize their messages.
// NOTE: runtime.cascade.user.deleted is a reserved topic — wired here ahead of
// the runtime emitting it (pending Central account-deletion). The handler is
// registered correctly but won't fire until that delta ships. See
// [Data & events → runtime events](/guide/data-and-events#runtime-published-events-you-can-subscribe-to).
await plugin.events.subscribe("runtime.cascade.user.deleted", async (event) => {
  const userId = (event.payload as { user_id?: string }).user_id;
  if (typeof userId === "string") {
    await plugin.db.run(
      "UPDATE messages SET content='[deleted]', author_id='[deleted]', attachments=NULL WHERE author_id = ?",
      [userId],
    );
  }
});

// An admin deleted a category → NULL the soft foreign key (channels fall back to "Uncategorized").
await plugin.events.subscribe("core.category.deleted", async (event) => {
  const id = (event.payload as { id?: string }).id;
  if (id) await plugin.db.run("UPDATE channels SET category_id = NULL WHERE category_id = ?", [id]);
});
```

Categories are referenced by id as a **soft FK** — there's no cross-plugin
foreign key, so the plugin listens for the delete and cleans up itself. This is
the standard pattern for referencing [core](/reference/backend-sdk#core)
categories.

## Files + the scheduled orphan sweep

Clients upload attachments straight to the runtime; the backend validates them at
`sendMessage` and stores only the filename + metadata in the row (URLs are signed
fresh per read). Files whose message is deleted become orphans, reclaimed by an
hourly schedule:

```ts
async function sweepOrphans() {
  const onDisk = await plugin.files.list();
  const referenced = await buildReferencedFilenames();   // scan messages.attachments
  for (const f of onDisk) {
    if (referenced.has(f.filename)) continue;
    if (Date.now() - f.mtime < ORPHAN_GRACE_MS) continue; // grace window for in-flight uploads
    await plugin.files.delete(f.filename);
  }
}

void plugin.schedule.every("attachments.orphan_gc", ORPHAN_GC_INTERVAL_MS, sweepOrphans);
void sweepOrphans();   // also run once at boot
```

Re-registering the same schedule name replaces the previous timer (idempotent
across reloads). The grace window prevents race-deleting a file a user just
uploaded but hasn't attached yet.

## Migrations

Schema is built by the SQL files in `migrations/`, applied in filename order
before the plugin spawns. `001_create_tables.sql` creates the tables and seeds a
default channel; later files (`002_add_threads.sql`, `003_add_category_id.sql`,
`004_attachments.sql`) add columns as the plugin grew — **append a new file,
never edit an applied one**:

```sql
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  topic TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX idx_messages_channel_time ON messages(channel_id, created_at);

INSERT INTO channels (id, name, topic, created_at)
VALUES ('00000000-0000-0000-0000-000000000001', 'general', 'General discussion', strftime('%s','now') * 1000);
```

## What to copy

- The **startup order** (handlers sync, subscriptions/schedule awaited after).
- The **gate → validate → write → publish → return** handler shape.
- Caching settings at module scope + `onChange`.
- Existence-checking any client-supplied id before using it.
- Append-only migrations.

From here: the [getting-started guide](/guide/getting-started) builds a smaller
plugin from scratch, and the [backend SDK reference](/reference/backend-sdk)
documents every method these handlers call.
