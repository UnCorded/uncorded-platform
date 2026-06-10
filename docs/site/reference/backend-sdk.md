# Backend SDK reference

`@uncorded/plugin-sdk`. Call `createPlugin()` once at startup; it wires the stdio
IPC transport, sends the `ready` handshake, and returns a `PluginHandle` exposing
the entire backend surface. Source of truth:
[`packages/plugin-sdk/src/types.ts`](https://github.com/UnCorded/uncorded-platform/blob/main/packages/plugin-sdk/src/types.ts).

```ts
import { createPlugin } from "@uncorded/plugin-sdk";

const plugin = createPlugin(/* { onFileUploaded } */);
```

`createPlugin(options?)` accepts one option, `onFileUploaded`, a callback fired
when a client finishes uploading a file to this plugin (see [files](#files)).

All methods that cross to the runtime are `async`. Errors arrive as
[`SdkError` / `SdkProtocolError`](#errors) with a stable `.code`.

## handle / request

```ts
plugin.handle(action: string, handler: (params, user) => unknown | Promise<unknown>): void
plugin.request<T>(action: string, params?: Record<string, unknown>): Promise<T>
```

- **`handle`** registers a handler for an inbound action. `params` is the
  caller's arguments; `user` is the authenticated caller
  (`{ id, displayName, avatarUrl, role }`). Return any JSON-serializable value;
  throwing surfaces an error to the caller. Register handlers **synchronously at
  startup** so they exist before the runtime routes requests.
- **`request`** sends a request to the runtime (cross-plugin calls / runtime
  services).

Two action names are special: `sidebar.items` (the shell calls it to build the
sidebar) and `schedule.tick` (handled for you by [`schedule`](#schedule)).

```ts
plugin.handle("getMessages", async (params, user) => {
  const channelId = params["channel_id"];
  if (typeof channelId !== "string") throw new Error("channel_id required");
  return plugin.db.query("SELECT * FROM messages WHERE channel_id = ?", [channelId]);
});
```

## events

Durable, acked, at-least-once event bus with per-(topic, subscriber) FIFO
ordering. Requires `events.publish` / `events.subscribe` capabilities.

```ts
plugin.events.publish(topic: string, payload: unknown, version?: number): void
plugin.events.subscribe(topic: string, handler: (event) => void, options?: SubscribeOptions): Promise<void>
plugin.events.unsubscribe(topic: string): Promise<void>
```

`SubscribeOptions`: `{ overflow_policy?: "mark_unhealthy" | "drop_oldest" | "drop_newest"; queue_size?: number }`.
Default backpressure is `mark_unhealthy` (failures are loud). The handler
receives an `event` with `{ topic, payload, version, ts, source_plugin }`. See
[Data & events](/guide/data-and-events#event-bus-durable-acked-plugin-to-plugin).

## db

The plugin's own SQLite. Requires `data.sql:self`.

```ts
plugin.db.query<T>(sql, params?): Promise<T[]>                 // SELECT → rows
plugin.db.run(sql, params?): Promise<{ changes, lastInsertRowid }>  // INSERT/UPDATE/DELETE
plugin.db.exec(sql): Promise<void>                             // DDL / PRAGMA
plugin.db.batch(statements): Promise<RunResult[]>              // atomic multi-statement
```

Always pass values via `?` placeholders. Use `batch()` when writes must commit
together. Schema is built by [migrations](/guide/plugin-anatomy#migrations).

## kv

String key/value backed by a `_kv` table in your SQLite. Requires `data.kv:self`.
Values are **always strings** — `JSON.stringify` complex values.

```ts
plugin.kv.get(key): Promise<string | null>
plugin.kv.set(key, value): Promise<void>
plugin.kv.delete(key): Promise<void>
plugin.kv.list(prefix?): Promise<{ key, value }[]>   // ordered by key
plugin.kv.getMany(keys): Promise<Record<string, string>>  // one round-trip
```

## settings

Read this plugin's admin-configurable settings (declared in `manifest.settings`)
and react to admin changes. **No capability required.**

```ts
plugin.settings.get(key): Promise<string | number | boolean>     // stored value or manifest default
plugin.settings.getAll(): Promise<Record<string, string | number | boolean>>
plugin.settings.onChange(handler: (ev: { key, value }) => void): () => void
```

`get` throws `UNKNOWN_SETTING` for an undeclared key. `onChange` fires once per
admin config save while the plugin runs; returns a disposer.

## broadcast

Push to connected WebSocket clients. Fire-and-forget, not durable. Requires
`broadcast.clients`. The runtime namespaces the event with your slug; the
frontend SDK strips it (so backend `"x"` ↔ frontend `sdk.on("x", …)`).

```ts
plugin.broadcast.toUser(userId, event, payload): Promise<void>
plugin.broadcast.toUsers(userIds, event, payload): Promise<void>   // ≤ 100 ids
plugin.broadcast.toAll(event, payload): Promise<void>
```

## presence

Connect/disconnect hooks (no capability) plus scoped ephemeral presence (folded
under `broadcast.clients`).

```ts
plugin.presence.onConnected(handler: (user) => void): () => void
plugin.presence.onDisconnected(handler: (user) => void): () => void

plugin.presence.join(scope, userId, meta?): Promise<() => Promise<void>>   // returns a leave fn
plugin.presence.leave(scope, userId): Promise<void>
plugin.presence.update(scope, userId, meta): Promise<void>                 // never implicitly joins
plugin.presence.watch(scope, cb: (entries) => void, { coalesceMs? }): Promise<() => void>  // default 50ms, clamps [0,500]
plugin.presence.list(scope): Promise<PresenceEntry[]>
```

Scopes are auto-prefixed with your slug — don't add the prefix yourself.
`join`/`leave`/`update` infer the originating WS session from request context, so
they must be called **inside a request handler** (they throw
`PRESENCE_NO_SESSION_CONTEXT` from a schedule tick or cross-plugin event handler).

## schedule

Recurring tasks. Requires `runtime.schedule`. Schedules are named; re-registering
a name replaces it. Minimum interval 1000ms.

```ts
plugin.schedule.every(name, intervalMs, handler: (tick) => void, options?): Promise<void>
plugin.schedule.cancel(name): Promise<void>
```

`options.timeout_ms` (default 30000) bounds how long the handler may block the
IPC slot per tick; on timeout the tick resolves with an error but the handler
keeps running in the background.

## fetch

Outbound HTTP via the runtime proxy. Requires `http.fetch:<hostname>` for each
host. Redirects are **never** followed (a 3xx is returned as-is).

```ts
const res = await plugin.fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ … }),   // string only; base64-encode binary yourself
});
res.status;           // number
res.headers;          // Record<string, string>
res.text();           // sync — body is pre-buffered
res.json<T>();        // sync
res.bytes();          // Uint8Array, sync
```

`.text()`/`.json()`/`.bytes()` are synchronous because the IPC round-trip already
buffered the full body.

## core

Read the Core Module's user-profile and category cache. **No capability
required.**

```ts
plugin.core.getUser(userId): Promise<CoreUser | null>
plugin.core.getUsers(userIds): Promise<CoreUser[]>           // missing ids omitted
plugin.core.getOnlineUsers(): Promise<CoreUser[]>
plugin.core.listCategories(): Promise<CoreCategory[]>        // admin-managed; reference by id (soft FK)
```

## data

Cross-plugin reads against another plugin's `public_schema`. Requires
`data.read:<plugin>.<table>`. Immutable builder — each method returns a new query.

```ts
const rows = await plugin.data
  .read<RowType>("text-channels", "messages")
  .where("channel_id", "=", id)
  .select(["id", "content", "created_at"])
  .orderBy("created_at", "desc")
  .limit(50)
  .exec();
```

Only published columns are selectable/filterable; the target DB is read-only.

## permissions

Your plugin's checks on its **users** (roles and plugin-defined permissions).
This is application logic — no manifest capability gates it.

```ts
plugin.permissions.register(key, { description, default_level }): Promise<void>
plugin.permissions.check(userId, permission, scope?): Promise<boolean>
plugin.permissions.hasRole(userId, roleName): Promise<boolean>
plugin.permissions.hasMinLevel(userId, level): Promise<boolean>
plugin.permissions.getRole(userId): Promise<{ name, level }>
plugin.permissions.canActOn(actorId, targetId): Promise<boolean>   // rank check for moderation
```

Register custom permission keys at startup; gate handlers with `check` /
`hasMinLevel`. Role levels are numeric (higher = more privileged).

## resources

Plugin resource permissions (per-resource ACLs). The runtime stamps your slug on
every define/create/grant/revoke, so you can only manage your **own** resources.
Cross-plugin `check` requires `resources.read:<owner-plugin>`.

```ts
plugin.resources.define({ resourceType, … }): Promise<void>
plugin.resources.create({ resourceType, resourceId, parent?, owner? }): Promise<PluginResourceRef>
plugin.resources.grant(resource, principal, action): Promise<{ aclVersion }>
plugin.resources.revoke(resource, principal, action): Promise<{ aclVersion }>
plugin.resources.check(userId, resource, action): Promise<AuthDecision>
```

The runtime returns `PLUGIN_RESOURCES_UNAVAILABLE` if booted without the resource
backend.

## files

Plugin file storage — the plugin's own `<dataDir>/uploads/`. Requires
`storage.file:self`. Clients POST to `/upload` directly; the runtime then fires
the `onFileUploaded` callback you pass to `createPlugin`. Use this API to
stat/sign/delete those files.

```ts
plugin.files.stat(filename): Promise<{ exists, size, mtime }>
plugin.files.signUrl(filename, userId, ttlSeconds?): Promise<{ url, exp }>  // default 1h, max 24h
plugin.files.delete(filename): Promise<{ deleted: boolean }>
plugin.files.list(): Promise<{ filename, size, mtime }[]>
```

`signUrl` returns a path-only URL (no host) bound to `userId`; the client
prefixes its current server origin so the URL survives tunnel hostname changes.

```ts
const plugin = createPlugin({
  onFileUploaded(msg) {
    // msg: { filename, path, size, mimeType, uploadedBy, uploadedAt }
  },
});
```

## voice

Voice bridge (LiveKit). Per-method capabilities; the runtime returns
`VOICE_BRIDGE_UNAVAILABLE` if booted without voice support.

```ts
// Capability: voice.tokens:self
plugin.voice.createJoinToken({ channelId, userId, grants?, canPublishSources? }): Promise<VoiceJoinToken>
// Capability: voice.moderation:self
plugin.voice.removeParticipant({ channelId, userId, reason? }): Promise<{ ok: true }>
```

`createJoinToken` returns `{ token, livekitUrl, expiresAt }`. The plugin is
responsible for ACL checks (channel exists, user not banned, role gate) before
minting. **Derive `canPublishSources` from the user's permissions** — never pass
client-supplied values through.

## serveReady

```ts
plugin.serveReady(): void
```

Signal that internal state is hydrated and the plugin can serve user requests.
Effective only when the manifest sets `serve_ready_handshake: true`; otherwise a
harmless no-op. See [Lifecycle](/guide/lifecycle#the-optional-serve-ready-handshake).

## errors

```ts
import { SdkError, SdkProtocolError } from "@uncorded/plugin-sdk";
```

Every error thrown across the SDK boundary is an `SdkError` (or subclass) with a
stable machine-readable `.code` and optional `.context`. `SdkProtocolError`
(a subclass) signals the runtime returned an error response or a payload that
didn't match the expected shape. Catch on `.code`, never on message text.

## request context

```ts
import { getCurrentSession, getRequestContext } from "@uncorded/plugin-sdk";
```

Inside a request handler, `getCurrentSession()` returns the originating WS
session id (or `undefined` for runtime-originated calls like a schedule tick).
This is the mechanism `presence.join/leave/update` use to attribute themselves to
the right session.
