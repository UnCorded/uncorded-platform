# Permissions reference

Every IPC call a plugin makes is checked against the capabilities listed in its
manifest `permissions` array. **Undeclared = hard reject** — there is no implicit
trust and no runtime workaround. Getting this array right is where most
first-attempt plugins fail, so this page maps each SDK feature to the exact
string it needs.

Two distinct concepts share the word "permission":

1. **Capabilities** (this page) — manifest strings that gate the plugin's access
   to runtime services. Enforced by the runtime on every IPC call.
2. **User permissions** — role/permission checks *your plugin* runs on its
   *users* via [`plugin.permissions`](/reference/backend-sdk#permissions) (e.g.
   "can this user post?"). Registered with `plugin.permissions.register()`. These
   are application logic, not manifest declarations.

## Grammar

```
resource.action[:scope]
```

Validated against:

```js
/^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*(?::[a-z0-9*][a-z0-9.*:-]*)?$/
```

`resource` and `action` are dotted identifiers; `scope` is optional and may
contain dots, colons, and `*` wildcards. Scope conventions:

- `:self` — the plugin's own resource (its own DB, its own files).
- `:<plugin>.<table>` — a specific cross-plugin target.
- `:<namespace>.*` — a prefix wildcard (events).
- `:<hostname>[:port]` — a network target (fetch).

## Capabilities by feature

| Capability | Unlocks (SDK) | Scope rules |
| --- | --- | --- |
| `data.sql:self` | [`plugin.db`](/reference/backend-sdk#db) — own SQLite | `:self` only |
| `data.kv:self` | [`plugin.kv`](/reference/backend-sdk#kv) — own key/value store | `:self` only |
| `data.read:<plugin>.<table>` | [`plugin.data.read`](/reference/backend-sdk#data) — read another plugin's published table | **no wildcards** — name an exact `plugin.table` |
| `events.publish:<ns>.*` | [`plugin.events.publish`](/reference/backend-sdk#events) | prefix wildcard or exact topic; publish only to **your** namespace |
| `events.subscribe:<pattern>` | [`plugin.events.subscribe`](/reference/backend-sdk#events) | prefix wildcard (`x.*`) or exact topic; **bare `*` rejected** |
| `broadcast.clients` | [`plugin.broadcast`](/reference/backend-sdk#broadcast) + scoped [`plugin.presence`](/reference/backend-sdk#presence) | no scope |
| `storage.file:self` | [`plugin.files`](/reference/backend-sdk#files) + the `/upload` endpoint | `:self` only |
| `http.fetch:<host>[:port]` | [`plugin.fetch`](/reference/backend-sdk#fetch) — outbound HTTP to that host | exact hostname (+ optional port) |
| `runtime.schedule` | [`plugin.schedule`](/reference/backend-sdk#schedule) — recurring tasks | no scope |
| `runtime.log` | structured logging to the runtime collector | no scope |
| `auth.currentUser` | current-user lookups | no scope |
| `voice.tokens:self` | [`plugin.voice.createJoinToken`](/reference/backend-sdk#voice) | `:self` |
| `voice.moderation:self` | [`plugin.voice.removeParticipant`](/reference/backend-sdk#voice) | `:self` |
| `proxy.http:self` | reverse-proxy HTTP forwarding for a `proxy_mount` | `:self` |
| `proxy.websocket:self` | reverse-proxy WebSocket forwarding (not implied by HTTP) | `:self` |
| `resources.read:<plugin>` | cross-plugin [`plugin.resources.check`](/reference/backend-sdk#resources) | exact owner-plugin slug |

> Capabilities that need **no** declaration: reading your own
> [`settings`](/reference/backend-sdk#settings), the [`core`](/reference/backend-sdk#core)
> user/category cache, presence connect/disconnect hooks, and registering your
> own [user permissions](/reference/backend-sdk#permissions). These are always
> available.

## runtime_capabilities (separate array)

Voice features are opted into via the manifest's `runtime_capabilities` array,
**not** `permissions`:

| Value | Gates |
| --- | --- |
| `voice.media` | LiveKit-mediated audio (the voice-channels plugin). |
| `voice.screen_share` | the plugin's ability to grant screen-share publish. |
| `voice.moderation` | admin "Stop their share" via LiveKit `RemoveParticipant`. |

Per-user authorization (e.g. `voice.screen_share.publish`) is a separate *user
permission* your plugin registers and checks — see above.

## Wildcard rules at a glance

| Pattern | `data.read` | `events.publish` | `events.subscribe` |
| --- | --- | --- | --- |
| exact (`x.y`) | ✅ | ✅ | ✅ |
| prefix (`x.*`) | ❌ | ✅ | ✅ |
| bare `*` | ❌ | ✅ | ❌ |

## Worked example

The text-channels plugin declares:

```json
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
```

Reading top to bottom: it owns a database, publishes its own events, listens for
user-deletion cascades, presence, its own events, and category deletions, pushes
real-time updates to clients, stores uploaded files, and runs a scheduled
orphan-GC sweep. Every SDK call it makes traces back to one of these lines.

The capability checker and its test suite are the executable spec:
[`runtime/src/capabilities/checker.ts`](https://github.com/UnCorded/uncorded-platform/blob/main/runtime/src/capabilities/checker.ts).
