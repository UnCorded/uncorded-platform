---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Every feature is a choice"
depends-on: [spec-04-plugin-architecture, spec-22-core-module]
last-verified: 2026-04-18
---

# 23 — Scoped Presence

*An ephemeral, per-WS-session membership primitive for arbitrary scopes — typing indicators, "users viewing this channel," collaborative cursors, and anything else that lives only while a connection is open. A platform primitive, not a plugin.*

---

## Why This Exists

The Core Module's `is_online` flag answers *"is this user on the server at all?"* It is durable, server-wide, and binary. Every plugin needs it, and the Core Module is the right home.

A second question comes up constantly and the existing primitive cannot answer it: *"who is in **this** thing right now?"*

- text-channels needs to know who is typing in a specific thread
- text-channels needs to show "3 people viewing #general"
- A future Excalidraw plugin needs live cursor positions per canvas
- A future HedgeDoc plugin needs per-document editor cursors
- A future voice room plugin needs "users currently in Room A"

Every one of these plugins would otherwise invent the same thing: an in-memory map keyed by some identifier, a cleanup hook on WS close, a fan-out mechanism, a rate limit. Five plugins, five incompatible implementations, five subtly different cleanup bugs.

Scoped presence is the shared primitive. It sits next to Core Module as a sibling runtime module — not folded into it, because the semantics are different (ephemeral vs durable, plugin-scoped vs server-wide, arbitrary meta vs fixed fields).

---

## Locked Decisions

- **Ephemeral, in-memory only.** State lives in the runtime process. Nothing is persisted. When the runtime restarts, all scoped presence is gone. Re-join on reconnect is the caller's problem.
- **Distinct from `is_online`.** Core Module's `users.is_online` remains the authoritative "is this user on the server" signal. Scoped presence never writes to `core.db`. They do not overlap and must not be conflated.
- **Per-WS-session, not per-user.** An entry is keyed by `(scope, session_id)`. A user with two tabs open can appear in the same scope twice, with independent meta. Callers that want per-user uniqueness deduplicate themselves.
- **Module location: `runtime/src/presence/`.** Not inside `runtime/src/core/`. The Core Module owns durable server state; presence owns volatile session state. Keeping them separate keeps each module's responsibility legible.
- **Scope grammar: `<plugin-slug>.<path>` — dot-delimited.** The plugin's slug is the first segment. The rest is the plugin's business. `text-channels.thread.abc123`, `excalidraw.canvas.home-page`, `voice.room.42` are all valid.
- **Runtime auto-prefixes with the calling plugin's slug.** The plugin calls `sdk.presence.join("thread.abc123", userId)` and the runtime stores the scope as `text-channels.thread.abc123`. Same pattern as `sdk.broadcast` (spec-04). Plugins cannot join scopes owned by other plugins — the prefix is enforced by the runtime, not asked for.
- **Capability: folded into `broadcast.clients`.** Scoped presence is a client-facing feature: you join to produce visible state for connected users. Anything that can push to clients can also maintain scoped presence. No new capability string is added. Plugins that already declare `broadcast.clients` get presence for free.
- **Authorization is backend-owned.** The runtime does no scope-level ACL. It does not know what a thread is, what a canvas is, or who is allowed to see them. The plugin gates membership by calling `join` **only after** its own authorization check. If a plugin lets an unauthorized user join a scope, that is a plugin bug, not a runtime bug.
- **Frontend SDK: zero additions.** Clients never talk to the runtime's presence module directly. They send plugin-mediated updates with `sdk.request()` (e.g. `setTyping`) and observe broadcast events with `sdk.on()`. Watch delivery to clients flows through `sdk.broadcast.toUsers()`, never directly from the runtime. This preserves the backend-owned ACL.
- **No persistence across restarts.** Intentional. Scoped presence is meaningful only while the WS sessions that produced it are open. Persisting it would produce stale-cursor-zombie bugs.

---

## What Scoped Presence Is Not

- **Not `is_online` replacement.** Core Module still owns server-wide online state. Scoped presence answers a different question.
- **Not a messaging primitive.** It does not carry content, only membership + arbitrary meta. Real-time message fan-out is `sdk.broadcast`; real-time event fan-out is the event bus.
- **Not a voice/WebRTC integration.** LiveKit and SFU media integration are a separate spec.
- **Not a thread data model.** "Users typing in a thread" uses this primitive, but the thread itself is text-channels' concern.
- **Not session storage.** It does not outlive WS sessions, and it does not outlive runtime restarts. For durable per-user state, use `sdk.kv` or a plugin table.

---

## Scope Grammar

```
<plugin-slug>.<path>
```

- `<plugin-slug>` is the calling plugin's slug. The runtime prepends it — the plugin never writes its own slug in the scope argument.
- `<path>` is anything the plugin wants, subject to basic sanity: dot-delimited segments, ASCII printable, 1–200 chars total after prefixing, no whitespace, no control characters.
- Scopes are opaque strings to the runtime. No wildcards, no hierarchy semantics at the runtime level. If a plugin wants hierarchy (e.g. channel → thread → message), it encodes it in the path and filters on its own side.

Examples (with the text-channels plugin calling):

| Plugin passes to SDK | Runtime stores |
|---|---|
| `"thread.abc123.typing"` | `text-channels.thread.abc123.typing` |
| `"channel.42.viewers"` | `text-channels.channel.42.viewers` |
| `"dm.xy.typing"` | `text-channels.dm.xy.typing` |

Attempts to pass a scope starting with another plugin's slug (e.g. `excalidraw.canvas.foo` from text-channels) are rejected at the runtime boundary.

---

## Authorization Model

Presence is authorization-agnostic by design.

**What the runtime does:**

- Verifies the caller is a plugin with `broadcast.clients` declared
- Prefixes the scope with the plugin's slug
- Enforces bounds (rate, meta size, scope length)
- Tracks session→scope membership
- Evicts on WS close
- Emits internal events to watchers

**What the runtime does not do:**

- Decide whether a user is allowed to join a scope
- Decide whether a watcher is allowed to observe a scope
- Decide whether a broadcast of presence state to clients is appropriate
- Keep secrets. Any plugin backend can `list` or `watch` any of its own scopes.

**What the plugin must do:**

- Run its ACL check before calling `join`. For text-channels, that means verifying the user is a member of the channel before joining them to `thread.<id>.typing`.
- Run its ACL check before fanning out presence changes to clients via `sdk.broadcast.toUsers()`. The plugin decides who sees what.
- Handle its own re-join on reconnect. The runtime does not remember past joins across WS sessions.

This mirrors `sdk.broadcast.toUsers()` — the runtime provides the pipe, the plugin provides the policy.

---

## Backend SDK Surface

Scoped presence is added to the existing `sdk.presence` namespace. The existing `onConnected` and `onDisconnected` hooks are unchanged; they remain the server-wide session hooks backed by `runtime.user.connected` / `runtime.user.disconnected`.

```ts
interface PresenceApi {
  // --- Existing (server-wide session hooks, unchanged) ---
  onConnected(handler: PresenceHandler): () => void;
  onDisconnected(handler: PresenceHandler): () => void;

  // --- New (scoped presence) ---

  /**
   * Join the calling session to a scope.
   * The scope is auto-prefixed with the plugin's slug.
   * Call only after the plugin's own ACL check.
   * Returns a leave function — calling it removes this exact entry.
   */
  join(
    scope: string,
    userId: string,
    meta?: Record<string, unknown>,
  ): Promise<() => Promise<void>>;

  /**
   * Leave a scope. Looks up the entry at (scope, calling_session); if one
   * exists and its user_id matches the argument, removes it and emits
   * runtime.presence.left. Otherwise a no-op. At most one entry can match,
   * because entries are keyed by (scope, session_id).
   */
  leave(scope: string, userId: string): Promise<void>;

  /**
   * Update meta for the calling session's entry in a scope.
   * If no entry exists for this (scope, userId, session), the call is a no-op
   * — update does not implicitly join.
   */
  update(scope: string, userId: string, meta: Record<string, unknown>): Promise<void>;

  /**
   * Observe changes to a scope. Fires on join, leave, update, and on
   * session-close evictions. Delivery is coalesced per watcher — the callback
   * receives the latest full entry list for the scope on each tick.
   */
  watch(
    scope: string,
    callback: (entries: PresenceEntry[]) => void,
    options?: { coalesceMs?: number },
  ): Promise<() => void>;

  /**
   * One-shot read of all entries currently in a scope.
   * Returns an array, empty if the scope has no members.
   */
  list(scope: string): Promise<PresenceEntry[]>;
}

interface PresenceEntry {
  scope: string;          // fully-qualified, including the plugin slug
  user_id: string;
  session_id: string;     // opaque runtime-assigned session identifier
  meta: Record<string, unknown>;
  joined_at: number;      // ms since epoch
  updated_at: number;     // ms since epoch
}
```

### Semantics

- **Session inference.** `join`, `leave`, and `update` infer the session from the current IPC request context. A plugin calling these outside a request context (e.g. from a `sdk.schedule` tick or a cross-plugin event handler) receives an error. Presence is a response to client activity, not a background operation.
- **Idempotent join.** Re-joining the same `(scope, session)` refreshes `updated_at` and replaces `meta`. It does not produce a second entry. A re-join with the same `(scope, session)` but a different `user_id` overwrites the existing entry's `user_id` as well — entries are keyed by `(scope, session_id)`, not by user.
- **`leaveFn` vs `leave()`.** The returned leave function is specific to the entry created by the call. `leave(scope, userId)` looks up the entry at `(scope, calling_session)` and removes it only if its `user_id` matches — useful when the caller does not hold a reference to the leave function. At most one entry can match.
- **`update` does not join.** If the entry has been evicted (e.g. the session closed and reconnected), `update` is a no-op. The plugin must observe a join-required event and re-join explicitly.
- **`update` emits unconditionally.** The runtime does not deep-equal-check `meta`. Every `update` call bumps `updated_at` and emits `runtime.presence.updated`, regardless of whether the new `meta` differs byte-for-byte from the old. This supports heartbeat patterns — a plugin can periodically `update` with the same `meta` to signal "user still present." Plugins that want value-diff-only notifications dedupe in their watcher handler.
- **`watch` delivers full state, not diffs.** Every tick carries the current entry list for the scope. This is cheap for small scopes (the common case) and keeps callers simple. If a scope grows large enough that full-list delivery matters, the scope is the wrong shape.

### Error Codes

Typed errors returned on the calling plugin's `join` / `leave` / `update` / `watch` / `list` promise:

| Code | When |
|---|---|
| `PRESENCE_NO_SESSION_CONTEXT` | The call has no request context at all — e.g. from an `sdk.schedule` tick or a cross-plugin event handler. Presence is a response to client activity, not a background operation. |
| `PRESENCE_SESSION_GONE` | A request context exists, but the WS session it points to has already closed — the session ended between the client's request reaching the plugin and the presence IPC arriving at the runtime. Distinct from `PRESENCE_NO_SESSION_CONTEXT`, where no session was ever in play. |

Bounds violations (rate, meta size, scope length) surface as separate typed errors per §Bounds and Limits.

### What is intentionally not here

- No cross-plugin presence reads. A plugin cannot `watch` or `list` another plugin's scopes. Presence is part of the plugin's internal state; if another plugin needs to know, publish an event.
- No "presence capability" permission string. The capability is `broadcast.clients`. There is one permission to reason about, not two.
- No `count(scope)` helper. Callers can read `list(scope).length` — avoiding a parallel code path.

---

## Frontend SDK

No additions. The frontend SDK remains exactly what it is today.

Plugin clients interact with presence indirectly:

- **Producing updates:** the client calls a plugin-defined request — `sdk.request("setTyping", { channelId, typing: true })` — and the plugin backend validates, calls `sdk.presence.join` or `update`, and fans out with `sdk.broadcast.toUsers()`.
- **Observing updates:** the client subscribes with `sdk.on("typing.changed", handler)` to a plugin-defined event. The plugin backend's watcher transforms scoped presence into that event payload and broadcasts it.

This keeps the backend-owned ACL intact. Every scoped presence change that a client sees has passed through the plugin's own authorization layer at broadcast time. The runtime never pushes presence to clients on its own.

---

## Wire Events

Scoped presence fan-out inside the runtime reuses the existing event bus. Three topics are emitted by the runtime presence module under the reserved `runtime.*` namespace.

| Topic | Payload | When |
|---|---|---|
| `runtime.presence.joined` | `{ scope, user_id, session_id, meta, ts }` | A new entry is created |
| `runtime.presence.updated` | `{ scope, user_id, session_id, meta, ts }` | An existing entry's meta is changed |
| `runtime.presence.left` | `{ scope, user_id, session_id, reason, ts }` | An entry is removed. `reason ∈ {"explicit","session_closed","plugin_unloaded"}`. |

- These are internal fan-out topics. Plugins do not subscribe to them directly via `sdk.events.subscribe`. The SDK's `watch(scope, ...)` implementation subscribes once per plugin process to the relevant topics, filters to the requested scope, applies coalescing, and invokes the caller's callback with the coalesced full entry list.
- The `runtime.*` namespace is reserved per spec-04; plugins cannot publish on these topics.
- `session_id` is the same identifier the runtime uses internally for WS session tracking. It is opaque to plugins, stable for the life of the WS session, and never reused.

Coalescing happens entirely on the subscriber side:
- Events arrive on the bus unthrottled (subject to the input ceiling below).
- The SDK buffers events per `(plugin, scope, watch handler)` for `coalesceMs` and then delivers one callback invocation with the current full entry list.
- A scope with no subscribers produces no fan-out work — topics are still published, but the bus has no consumers, so delivery is a no-op.

For **client** fan-out, the plugin's watch handler transforms the entry list into a plugin-defined payload and calls `sdk.broadcast.toUsers(...)`. The runtime never emits presence state to WS clients on its own.

---

## Lifecycle

### On WS session close

1. Runtime identifies all `(scope, session_id)` entries owned by the closing session.
2. For each, remove the entry and emit `runtime.presence.left` with `reason: "session_closed"`.
3. Watchers see the next coalesced tick reflect the departures.

No separate "session ended" hook is needed at the presence level — `runtime.presence.left` with `reason: "session_closed"` carries enough information.

### On plugin unload or reload

1. Runtime removes all entries owned by the unloading plugin (scopes starting with its slug).
2. For each, emit `runtime.presence.left` with `reason: "plugin_unloaded"`.
3. The plugin's own watchers are gone, so only other-plugin listeners would see these — in practice, no-one, because cross-plugin presence reads are not supported.

### On runtime restart

All scoped presence state is lost. Reconnecting clients trigger fresh joins via their plugin's normal flow. The runtime does not attempt to rehydrate from any snapshot.

### On reconnect by the same user

The new WS session is a new `session_id`. Any presence the user's previous session held is already evicted. The plugin is responsible for observing the new session (e.g. via an initial `setTyping`-style request from the client) and calling `join` again if appropriate.

---

## Bounds and Limits

These are enforced by the runtime at the SDK boundary. They are DoS guards and sanity clamps, not quality knobs for plugin authors to tune.

| Bound | Value | Notes |
|---|---|---|
| Input rate | ~120 updates/sec/user/scope | Combined rate of `join` + `update` + `leave` for a given `(user, scope)`. Excess calls are rejected with a typed error. |
| `meta` size | 1 KB per entry | Serialized JSON length. `join`/`update` with a larger `meta` is rejected. |
| Scope length | 200 chars after prefixing | Rejected at the runtime boundary. |
| `coalesceMs` | default 50, range 0–500 | Out-of-range values clamp. 0 means no coalescing (every event produces a callback). |
| Entries per scope | soft 10_000 | A warning is logged and overflow events go to the standard observability path; no hard cap. Scopes this large are a design smell. |
| Scopes per plugin | unbounded | Enforced implicitly by memory and the standard plugin watchdog. |

The input rate ceiling matters: a buggy client sending 10_000 typing events per second cannot push the runtime into meaningful work. The ceiling is per `(user, scope)` to keep it simple — a user typing in five threads is not throttled against themselves across threads.

Violations produce a typed error that propagates back to the calling plugin's `join`/`update` promise. The plugin decides whether to surface it to the client.

---

## Relationship to the Core Module

| Dimension | Core Module `users.is_online` | Scoped Presence |
|---|---|---|
| Durability | Durable (SQLite row) | In-memory only |
| Scope | Server-wide | Arbitrary plugin-defined scope |
| Payload | Fixed (boolean) | Arbitrary `meta` per entry |
| Lifecycle | Updated on WS open/close, persists across restarts | Dies with session and runtime |
| Access | `sdk.core.*` — no capability required | `sdk.presence.*` — requires `broadcast.clients` |
| Fan-out | `core.user.online` / `core.user.offline` | `runtime.presence.joined` / `left` / `updated` |
| Authorization | Universal read | Plugin-gated read/write |

The two are orthogonal. A user can be `is_online = 1` globally while present in zero scopes. A user cannot be in any scope while `is_online = 0` (because session-close evicts their entries first — both the core row flip and the scope evictions happen on WS close).

---

## Use Cases (for calibration, not binding)

- **text-channels typing indicators.** Scope: `text-channels.thread.<id>.typing`. Meta: `{}`. The plugin joins when the client sends `setTyping(true)`, leaves on `setTyping(false)` or after a 5s idle timeout the plugin enforces, and broadcasts watcher ticks to channel members.
- **text-channels "who is viewing this channel."** Scope: `text-channels.channel.<id>.viewers`. Meta: `{ focused: boolean }`. Join on channel open, leave on channel close, update `focused` on window focus change.
- **Future: Excalidraw cursors.** Scope: `excalidraw.canvas.<id>.cursors`. Meta: `{ x, y, color, selection }`. Updated at ~30 Hz (well under the 120/sec ceiling); coalesced to a 50ms watcher tick.
- **Future: HedgeDoc editor cursors.** Scope: `hedgedoc.doc.<id>.cursors`. Meta: `{ line, col, selection }`.
- **Future: voice room occupancy.** Scope: `voice.room.<id>.occupants`. Meta: `{ muted, deafened, speaking }`. Updated by the voice plugin as users join and change state.

None of these are promised by this spec — they are included to confirm the primitive's shape is right. The actual plugins define their own scopes and meta shapes.

---

## Phase Scope

| Feature | Phase |
|---|---|
| `runtime/src/presence/` module | Phase 2 |
| `sdk.presence.join` / `leave` / `update` / `watch` / `list` | Phase 2 |
| `runtime.presence.joined` / `left` / `updated` event topics | Phase 2 |
| Session-close eviction | Phase 2 |
| Input rate and meta size enforcement | Phase 2 |
| text-channels thread typing using scoped presence | Phase 2 |
| "Users viewing channel" indicators in text-channels | Phase 2 |
| Excalidraw / HedgeDoc cursor integration | Phase 3 (with those plugins) |
| Voice room occupancy integration | Phase 3 (with voice-channels SFU) |

---

## Future Refinements

### Cross-plugin scoped presence reads
- **What changes:** A plugin could `watch` or `list` another plugin's scopes with a declared capability (e.g. `presence.read:<plugin>.<path>`).
- **Why not now:** No Phase 2 consumer needs this. Every current use case is the owning plugin observing its own state.
- **What today's code must not do:** The capability grammar has room for `presence.read:<plugin>.<path>`. Do not use the `presence` namespace for anything else.

### Durable-handoff presence (aka "last seen in")
- **What changes:** On session close, write a small "last scope + timestamp" record so a reconnecting client can land back in the same context.
- **Why not now:** Handoff is a UX smoothing feature. Phase 2 clients handle it client-side by replaying their last-known context on reconnect.
- **What today's code must not do:** The eviction path must not assume nothing downstream ever cares about a departing session's scopes. Keep `runtime.presence.left` payloads carrying `reason: "session_closed"` — future durable-handoff code subscribes to those and writes them.

### Presence-driven broadcast routing
- **What changes:** `sdk.broadcast.toScope(scope, event, payload)` — fan out to every user currently present in a scope without the plugin having to materialize the user list.
- **Why not now:** Plugins already have `watch` + `toUsers`. The helper is convenient but not essential, and adding it before the primitive is battle-tested would freeze interface choices too early.
- **What today's code must not do:** The broadcast API surface stays tight to `toUser`/`toUsers`/`toAll`. Don't introduce alternate fan-out paths that would conflict with a future `toScope`.

### Hard per-scope entry cap
- **What changes:** Convert the 10_000/scope soft warning into a hard cap that rejects new joins.
- **Why not now:** No real workload approaches that number. A hard cap might rule out legitimate future use cases we have not yet imagined (large room occupancy with lightweight meta).
- **What today's code must not do:** Phase 2 enforcement is soft (log + observability event). The data path must tolerate scopes at the soft ceiling without degrading — no N² fan-out, no O(N) work per unrelated event.

---

## Relationship to Other Docs

- `spec-04-plugin-architecture.md` — capability grammar (`broadcast.clients`), event bus semantics, reserved `runtime.*` namespace, slug auto-prefixing pattern
- `spec-22-core-module.md` — durable `is_online` and the member/moderation boundary that scoped presence does **not** cross
- `spec-06-authentication.md` — WS auth and session identity; session-close is the eviction trigger for scoped presence
