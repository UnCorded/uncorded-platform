# Data & events

How a plugin stores state, reacts to things happening, and pushes updates to
clients. Four mechanisms, each with a different shape:

| Mechanism | For | Capability |
| --- | --- | --- |
| **SQLite** (`plugin.db`) | structured, queryable, durable data | `data.sql:self` |
| **KV** (`plugin.kv`) | simple string key/value | `data.kv:self` |
| **Event bus** (`plugin.events`) | plugin ↔ plugin / runtime, durable, acked | `events.publish` / `events.subscribe` |
| **Broadcast** (`plugin.broadcast`) | backend → connected clients, fire-and-forget | `broadcast.clients` |

## SQLite — your own database

Each data-owning plugin gets a private SQLite database (WAL mode). All access is
routed through IPC, so every call is `async`:

```ts
// SELECT → array of row objects
const rows = await plugin.db.query<Channel>(
  "SELECT id, name FROM channels WHERE category_id = ? ORDER BY position",
  [categoryId],
);

// INSERT/UPDATE/DELETE → { changes, lastInsertRowid }
const res = await plugin.db.run(
  "UPDATE channels SET name = ? WHERE id = ?",
  [name, id],
);

// DDL / PRAGMA → void
await plugin.db.exec("CREATE TABLE IF NOT EXISTS …");

// Multiple statements, atomically
await plugin.db.batch([
  { sql: "INSERT INTO messages (...) VALUES (...)", params: [...] },
  { sql: "UPDATE messages SET reply_count = reply_count + 1 WHERE id = ?", params: [parentId] },
]);
```

Always use **parameter placeholders** (`?`), never string interpolation. Use
`batch()` when several writes must land together. Schema is built by
[migrations](/guide/plugin-anatomy#migrations). Full method list:
[Backend SDK → db](/reference/backend-sdk#db).

### Cross-plugin reads

To read another plugin's data, that plugin must publish the table in its
manifest `public_schema`, and you must declare `data.read:<plugin>.<table>`. You
then get a read-only query builder:

```ts
const channels = await plugin.data
  .read("text-channels", "channels")
  .where("category_id", "=", categoryId)
  .select(["id", "name"])
  .orderBy("position")
  .limit(50)
  .exec();
```

Only published columns are readable; the target DB is opened read-only. There is
no cross-plugin write — ever.

## KV — string key/value

Backed by a `_kv` table in your own SQLite. Values are **always strings** —
serialize objects yourself. Requires `data.kv:self`.

```ts
await plugin.kv.set("config:theme", JSON.stringify({ accent: "blue" }));
const raw = await plugin.kv.get("config:theme");        // string | null
const all = await plugin.kv.list("config:");            // prefix scan
const many = await plugin.kv.getMany(["a", "b", "c"]);  // one round-trip
await plugin.kv.delete("config:theme");
```

Reach for KV for small, flat state (a counter, a cached token, a feature flag).
For anything you'd query or filter, use SQLite.

## Settings — admin-configurable values

Settings declared in the manifest's `settings` array are editable by admins in
Server settings and readable by your plugin. No capability needed — a plugin
always reads its own settings.

```ts
const len = await plugin.settings.get("max_message_length");  // value or manifest default
const all = await plugin.settings.getAll();

// React to an admin changing a value while the plugin runs:
plugin.settings.onChange((ev) => {
  console.error(`setting ${ev.key} → ${ev.value}`); // refresh your cache
});
```

The common pattern (from text-channels): cache settings at module scope, refresh
on boot, and re-read in `onChange`. See the
[example walkthrough](/examples/text-channels#settings).

## Event bus — durable, acked, plugin-to-plugin

The event bus is for **state changes other plugins (or the runtime) care about**.
Delivery is **at-least-once** with **per-(topic, subscriber) FIFO** ordering;
each delivery is acknowledged by the SDK automatically.

```ts
// Publish. Topic must be in your own namespace (your slug). Requires
// events.publish:<slug>.* (or a specific topic).
plugin.events.publish("text-channels.channel.created", channel);

// Subscribe. Requires events.subscribe:<pattern>. Returns once the
// subscription is acknowledged.
await plugin.events.subscribe("core.category.deleted", async (event) => {
  const id = (event.payload as { id: string }).id;
  await plugin.db.run("UPDATE channels SET category_id = NULL WHERE category_id = ?", [id]);
});
```

Key rules:

- You publish only into your **own** namespace; the `runtime.*` namespace is
  reserved for the runtime.
- Subscribe with a prefix wildcard (`text-channels.*`) or an exact topic. A bare
  `*` is not allowed for subscribe.
- **Backpressure** (`SubscribeOptions.overflow_policy`): the default is
  `mark_unhealthy` — if your subscriber's queue fills, the subscription is marked
  unhealthy (failures are loud, not silently dropped). `drop_oldest` /
  `drop_newest` opt into lossy delivery instead.

### Runtime-published events you can subscribe to

The runtime emits lifecycle events plugins commonly react to. These fire today:

| Topic | Fires when | Typical use |
| --- | --- | --- |
| `runtime.cascade.user.banned` | Central reports a user banned (payload `{ user_id, reason }`) | revoke their access, close sessions |
| `runtime.cascade.user.profile_changed` | a user's username/display name/avatar changes | refresh cached author profiles |
| `runtime.presence.joined` / `.updated` / `.left` | a user connects/disconnects or scoped presence changes (also via `plugin.presence`) | live member state |
| `core.category.created` / `.updated` / `.deleted` / `.reordered` | an admin manages sidebar categories (`.deleted` payload `{ id }`) | null soft-FKs, re-render groups |

Subscribe to a family with a wildcard — `runtime.cascade.*`, `runtime.presence.*`,
`core.category.*` — and switch on the exact topic inside the handler. Subscribing
requires the matching `events.subscribe:` capability.

::: warning Reserved, not yet emitted
`runtime.cascade.user.deleted` (account deletion) is a **reserved** topic: it is
part of the contract and safe to subscribe to, but the runtime does not emit it
yet — the delta handler is wired up once Central adds account-deletion to its
heartbeat delta protocol. A subscription compiles and registers fine; the handler
simply never fires until then. Don't rely on it as your only cleanup path for
removed users today. (`core.user.deleted` is defined alongside it and is gated on
the same Central work.)
:::

## Broadcast — push to connected clients

Broadcast is the **backend → client** channel for real-time UI updates. It's
fire-and-forget (no ack, not durable) and lands in the frontend SDK as
`sdk.on(event, …)`. Requires `broadcast.clients`.

```ts
await plugin.broadcast.toUser(userId, "notification", { text: "…" });
await plugin.broadcast.toUsers([u1, u2], "typing.updated", { users });  // ≤ 100 ids
await plugin.broadcast.toAll("entry.added", entry);
```

The runtime namespaces the event with your slug on the wire
(`"entry.added"` → `"guestbook.entry.added"`); the frontend SDK strips the prefix
so you write `sdk.on("entry.added", …)`. See
[Frontend SDK → on](/reference/frontend-sdk#on-broadcasts).

### Event bus vs. broadcast — which one?

- **Other plugins or durability matter** → event bus (`plugin.events`).
- **Just update open client UIs right now** → broadcast (`plugin.broadcast`).

A common pairing: write to SQLite, `events.publish` for any plugin that's
listening, and `broadcast.toAll` so open panels update instantly.

## Presence

`plugin.presence` gives you connect/disconnect hooks (no capability) and scoped,
ephemeral presence (who's "in" a channel, who's typing) folded under
`broadcast.clients`:

```ts
plugin.presence.onConnected((user) => { /* … */ });

// Inside a request handler (it infers the WS session from request context):
const leave = await plugin.presence.join(`channel.${id}.typing`, user.id, {
  typing_until: Date.now() + 4000,
});
const unwatch = await plugin.presence.watch(`channel.${id}.typing`, (entries) => {
  // broadcast the live list to viewers
}, { coalesceMs: 50 });
```

Scopes are auto-prefixed with your slug. `join`/`leave`/`update` must run inside
a request handler's async context (they throw `PRESENCE_NO_SESSION_CONTEXT`
otherwise). Full surface: [Backend SDK → presence](/reference/backend-sdk#presence).
