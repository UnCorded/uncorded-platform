# IPC protocol

How the runtime and a plugin backend talk. You never write this by hand — the
[backend SDK](/reference/backend-sdk) speaks it for you — but understanding the
wire format makes logs, timeouts, and size limits legible. Source of truth:
[`runtime/src/ipc`](https://github.com/UnCorded/uncorded-platform/blob/main/runtime/src/ipc)
and the schemas in
[`packages/protocol-schemas/src/index.ts`](https://github.com/UnCorded/uncorded-platform/blob/main/packages/protocol-schemas/src/index.ts).

## Transport — stdio, newline-delimited JSON

Each plugin runs as a subprocess. The runtime owns its `stdin`/`stdout`; the
channel is **newline-delimited JSON over stdio** — one JSON object per line.

- **Plugin → runtime:** stdout lines **prefixed with `IPC:`** are protocol
  messages (`IPC:{"type":"ready"}`). Any other stdout line, and **all stderr**,
  is captured by the runtime's log collector. So `console.error(...)` from a
  plugin shows up in runtime logs; it never corrupts the protocol.
- **Runtime → plugin:** plain JSON lines on the plugin's stdin.
- **Don't read stdin** or write raw `IPC:` lines yourself — the transport owns
  both.

### Size limit

A single IPC line is capped at **`MAX_IPC_LINE_BYTES` = 4 MB**. Consequences:

- An inbound line that exceeds 4 MB with no newline is a fatal framing error —
  the runtime kills the subprocess (a plugin can't be allowed to exhaust memory
  buffering one unbounded line).
- A handler **response** is bounded to slightly under 4 MB (4 MB minus envelope
  headroom). Exceed it and the SDK surfaces a catchable `RESPONSE_TOO_LARGE`
  error instead of silently dropping the reply. Paginate or stream large results
  (e.g. cap a list query and pass a cursor) rather than returning everything.

## Message envelope

Every message is an object with a string `type`. Request/response-style messages
also carry a string `id` used to correlate a reply with its request. Beyond
those two fields the envelope is open — actions add their own params without
changing the protocol.

## Runtime → plugin frames

The SDK dispatcher routes exactly these `type`s
(`RuntimeToPluginMessageSchema`); anything else is silently ignored, so adding a
new runtime frame never breaks an old plugin:

| `type` | Meaning | Key fields |
| --- | --- | --- |
| `request` | A user/caller is invoking one of your [`handle`](/reference/backend-sdk#handle-request) actions. | `id`, `action`, `params`, `user` `{id, displayName, avatarUrl, role}`, `session_id?` |
| `response` | The runtime's reply to a service call **you** made (db, kv, fetch, …). | `id`, `result?`, `error?` |
| `event.ack` | Acknowledges an [`events.publish`](/reference/backend-sdk#events) / subscribe. | `id`, `ok`, `event_id?`, `error?` |
| `event.deliver` | An event-bus delivery to one of your subscriptions. | `topic`, `version`, `id`, `ts`, `source_plugin`, `payload` |
| `ping` | Watchdog heartbeat. SDK auto-replies `pong`. | — |
| `file.uploaded` | A client finished uploading to your `/upload`. Fires `onFileUploaded`. | `filename`, `path`, `size`, `mimeType`, `uploadedBy`, `uploadedAt` |
| `core.plugin.config_changed` | An admin changed one of your settings. Fires `settings.onChange`. | `key`, `value`, `changed_by_user_id`, `ts` |

## Plugin → runtime frames

The SDK sends these on your behalf. The lifecycle/heartbeat frames:

| `type` | When |
| --- | --- |
| `ready` | Sent by `createPlugin()` once the SDK is wired — the [ready handshake](/guide/lifecycle#the-ready-handshake). |
| `serve_ready` | Sent by [`serveReady()`](/reference/backend-sdk#serveready) when caches are warm (opt-in). |
| `pong` | Auto-reply to each `ping`. |
| `response` | Your handler's result for an inbound `request`. |

Everything else a plugin sends is a **typed service call** — a request/response
pair where the `type` names the runtime service and the runtime replies with a
`response` carrying the same `id`. These map one-to-one onto SDK methods, e.g.
`data.sql` ([`db`](/reference/backend-sdk#db)), `data.kv`
([`kv`](/reference/backend-sdk#kv)), `data.read`, `events.publish` /
`events.subscribe` / `events.unsubscribe`, `broadcast.toAll` /
`broadcast.toUsers`, `http.fetch` ([`fetch`](/reference/backend-sdk#fetch)),
`schedule.register`, `presence.*`, `permissions.*`, `resources.*`,
`storage.file`, `voice.tokens` / `voice.moderation`, `core.*`. Use the SDK — the
frame names are an implementation detail listed here only for log-reading.

## Capability enforcement

Every typed service call is checked against the plugin's manifest
[`permissions`](/reference/permissions) **at the runtime boundary**, before the
service runs. An undeclared capability is a **hard reject** — the call comes back
as an error `response`, never a partial result. There is no per-call override:
if it isn't in the manifest, it cannot happen. This is why the
[permissions reference](/reference/permissions) maps each SDK feature to its
exact capability string.

## Error envelope

An error `response` carries a structured error, not a bare string:

```json
{ "type": "response", "id": "…", "error": { "code": "PERMISSION_DENIED", "message": "…", "context": { } } }
```

The SDK rethrows this as an [`SdkError`](/reference/backend-sdk#errors) whose
`.code` equals the envelope `code`. Always branch on `.code`; the `message` is
for humans and the `context` is optional diagnostic detail.

## See also

- [Lifecycle](/guide/lifecycle) — where `ready`/`ping`/`pong` sit in the boot and
  watchdog flow, and the message-frames table in context.
- [Backend SDK](/reference/backend-sdk) — the methods these frames implement.
