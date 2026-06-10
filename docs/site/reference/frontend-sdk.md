# Frontend SDK reference

`@uncorded/plugin-sdk-frontend`. The browser side of a plugin — the code that
runs inside the sandboxed iframe the shell renders for your panel. It talks to
your backend over the shell via `postMessage`, never directly. Source of truth:
[`packages/plugin-sdk-frontend/src`](https://github.com/UnCorded/uncorded-platform/blob/main/packages/plugin-sdk-frontend/src).

## Loading the SDK

The runtime serves a prebuilt IIFE bundle at `/sdk/plugin-frontend.js`. Load it
with a classic `<script>` tag (not a module import) — a sandboxed iframe has an
opaque origin, and a classic `<script src>` is a no-CORS fetch that loads
regardless. The bundle sets `window.UncodedPlugin`:

```html
<script src="/sdk/plugin-frontend.js"></script>
<script>
  (async () => {
    const sdk = await window.UncodedPlugin.createPluginFrontend();
    const entries = await sdk.request("listEntries");
    // … render …
  })();
</script>
```

`window.UncodedPlugin` exposes `createPluginFrontend` plus the avatar helpers
(`createAvatar`, `avatarHtml`, `avatarColor`, `avatarInitial`, `isSafeAvatarUrl`).
If you bundle your frontend instead, `import { createPluginFrontend } from
"@uncorded/plugin-sdk-frontend"` works too.

## createPluginFrontend

```ts
const sdk = await createPluginFrontend(options?: { handshakeTimeoutMs?: number });
```

Performs the shell handshake and resolves to a fully-initialized
`PluginFrontend`. **`await` it before calling anything else.**

### The handshake

On call the SDK derives the shell origin from `document.referrer`, posts
`uncorded.ready` (carrying its `SDK_API_VERSION`) to the parent, and waits for
the shell's `uncorded.token` reply (`{ token, slug, runtimeCapabilities,
itemId?, itemLabel? }`). Default timeout **5000ms** — override with
`handshakeTimeoutMs`. Failure throws a [`PluginError`](#errors) with code
`HANDSHAKE_FAILED` (no resolvable referrer — i.e. not running inside a shell) or
`HANDSHAKE_TIMEOUT`. Every subsequent inbound message is origin-checked against
the verified shell origin; every outbound message is targeted at it (never `*`).

## slug / token

```ts
sdk.slug;   // string — this plugin's slug, assigned by the runtime
sdk.token;  // string — the session bearer token (used by files/proxy internally)
```

## request

```ts
sdk.request<T>(action: string, params?: Record<string, unknown>): Promise<T>
```

Calls a backend [`plugin.handle(action, …)`](/reference/backend-sdk#handle-request)
and resolves with its return value. Correlated by id over `postMessage`.
**Timeout 30s** → rejects with `PluginError` code `REQUEST_TIMEOUT`; a backend
error rejects with that error's `.code`.

```ts
const messages = await sdk.request("getMessages", { channel_id: id });
```

## subscribe (event bus)

```ts
sdk.subscribe<T>(topic: string, handler: (payload: T) => void): () => void
```

Subscribe to a server-side **event-bus** topic (the same topics the backend
[`events`](/reference/backend-sdk#events) bus carries, e.g.
`"text-channels.message.created"`). Sends a `subscribe` message to the shell so
the runtime routes matching events to this iframe. Returns an unsubscribe
function.

## on (broadcasts)

```ts
sdk.on<T>(event: string, handler: (payload: T) => void): () => void
```

Receive **broadcasts** pushed from your backend via
[`plugin.broadcast`](/reference/backend-sdk#broadcast). The slug prefix is
stripped transparently: the backend sends `broadcast.toAll("entry.added", …)`
(on the wire `"<slug>.entry.added"`) and you write:

```ts
sdk.on("entry.added", (entry) => { /* prepend to the list */ });
```

No subscribe message is sent — broadcasts are pushed directly to the WS
connection and the shell routes all your slug-prefixed events here. Returns an
unsubscribe function.

> **subscribe vs on:** `subscribe` = durable event-bus topics (cross-plugin,
> runtime). `on` = your backend's fire-and-forget UI pushes. Most live-UI
> updates use `on`.

## onNavigate

```ts
sdk.onNavigate(handler: (nav: { itemId: string; itemLabel: string }) => void): () => void
```

Fires when the user selects one of your sidebar items. If the iframe opened
*onto* an item, the handler is invoked once on registration (next microtask)
with the initial navigation, so you don't miss the first selection. Returns an
unsubscribe function.

```ts
sdk.onNavigate(({ itemId }) => loadChannel(itemId));
```

## files

```ts
sdk.files.upload(file: Blob | File, options?: UploadOptions): Promise<UploadResult>
```

Uploads a user-selected file to **your** plugin's storage (the runtime's
`POST /upload`, authed with the session token and pinned to your slug — the
backend needs [`storage.file:self`](/reference/permissions)). The server picks
the on-disk filename; pass the returned `filename` back through your backend to
record it.

```ts
const res = await sdk.files.upload(file, {
  onProgress: ({ ratio }) => setBar(ratio),
  signal: controller.signal,
  maxBytes: 25 * 1024 * 1024,
});
// res: { filename, size, mime, originalName }
```

- `UploadResult`: `{ filename, size, mime, originalName }`.
- `UploadProgress`: `{ loaded, total, ratio }` (~10 Hz).
- Files ≤ 50 MB go single-shot; larger use resumable chunked upload (5 GB hard
  ceiling, set by the runtime).
- Failures throw [`UploadError`](#errors) with a `.code` (`ABORTED`,
  `PAYLOAD_TOO_LARGE`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`,
  `NETWORK_ERROR`, `TIMEOUT`, `UPLOAD_EXPIRED`, `INTEGRITY_FAILED`, …).

The backend's [`onFileUploaded`](/reference/backend-sdk#files) callback fires
once the upload lands, so the backend can record it in its own DB.

## proxy

```ts
sdk.proxy.openMount(mount: string): Promise<{ iframeUrl: string; openUrl: string }>
```

Bootstrap a manifest [`proxy_mounts`](/reference/manifest#proxy_mounts) entry:
mints the proxy-session cookie and returns `iframeUrl` (set as a nested iframe
`src`) and `openUrl` (an "Open in browser" fallback, required under Safari ITP).
Throws [`ProxyError`](#errors) (`NOT_FOUND`, `NOT_APPROVED`, `FORBIDDEN`,
`UNAUTHORIZED`, `RATE_LIMITED`, …). Full guide:
[Reverse-proxy plugins](/sdk/reverse-proxy).

## platform

Shell-mediated UI capabilities. None require a manifest capability (except voice,
gated by `runtime_capabilities`) — the shell decides whether to honor each.

### platform.panels

```ts
sdk.platform.panels.open(options: {
  itemId: string; itemLabel: string; itemIcon?: string;
  placement?: "beside-current" | "replace-current";
  mode?: "reuse-or-create" | "new";
}): void
sdk.platform.panels.focusCurrent(): void
```

Ask the shell to open another panel for **this same plugin** (the new iframe gets
`itemId`/`itemLabel` via `onNavigate`), or focus/fullscreen the current one.

### platform.userCard

```ts
sdk.platform.userCard.show({ userId: string; displayName?: string; avatarUrl?: string | null }): void
```

Surface the shell's rich user card. Wire it to avatar clicks so every plugin gets
the same card UX for free.

### platform.files

```ts
sdk.platform.files.preview({ url: string; name: string }): void
sdk.platform.files.download({ url: string; name: string }): void
```

Open the shell's file-preview overlay, or trigger a native download. URLs are
pinned to your runtime origin. Use these instead of an in-iframe `<a download>`,
which is unreliable cross-origin and on Linux Electron.

### platform.voice

The iframe side of the `platform.voice.*` postMessage contract. The shell owns
the LiveKit room and pushes state in; the plugin posts user intent back. The
plugin never imports `livekit-client` or touches `getUserMedia`. Gated by
`runtime_capabilities` (declared in the manifest) — read the grant flags before
rendering affordances:

```ts
const v = sdk.platform.voice;
v.granted;             // voice.media granted?
v.screenShareGranted;  // voice.screen_share granted?
v.moderationGranted;   // voice.moderation granted?
```

Intent methods (fire-and-forget): `connect({ channelId, channelName? })`,
`disconnect()`, `setMicMuted(muted)`, `setLocalParticipantMuted({ userId, muted })`,
`setLocalParticipantVolume({ userId, volume })`, `setDeafened(deafened)`,
`startAudio()` (call from a click handler to unblock autoplay),
`startScreenShare({ audio, quality, sourceId? })`, `stopScreenShare()`,
`setScreenShareQuality(q)`, `subscribeScreenShare(sid)` /
`unsubscribeScreenShare(sid)`, `popoutScreenShare(sid)` / `dockScreenShare(sid)`,
`setScreenShareVolume(sid, pct)`, `muteScreenShareAudio(sid, muted)`,
`adminStopScreenShare({ channelId, userId, reason? })`,
`observeScreenSlot(el, trackSid, slotId)` (returns a dispose fn).

State pushes (each returns an unsubscribe fn): `onState(state)`,
`onParticipants(list)`, `onActiveSpeakers(ids)` (throttled ≤5/s), `onError(err)`,
`onScreenShareSubscriptions(subs)`, `onScreenSharePopouts(popouts)`.

Voice is a large subsystem; the canonical consumer is the `voice-channels`
plugin frontend.

## Avatar helpers

Framework-agnostic, safe in vanilla iframes. Color and initial are deterministic
from `userId`, so the runtime, shell, and every plugin pick the same hue:

```ts
const { createAvatar, avatarHtml, avatarColor, avatarInitial, isSafeAvatarUrl } = window.UncodedPlugin;

container.appendChild(createAvatar({ userId, displayName, avatarUrl, size: 32, shape: "circle" }));
el.innerHTML = avatarHtml({ userId, displayName });   // string form
```

`isSafeAvatarUrl(url)` returns true only for `http(s)` — use it before trusting a
user-supplied avatar URL.

## errors

| Class | Thrown by | Notable `.code`s |
| --- | --- | --- |
| `PluginError` | `createPluginFrontend`, `request` | `HANDSHAKE_FAILED`, `HANDSHAKE_TIMEOUT`, `REQUEST_TIMEOUT`, `REQUEST_FAILED` (or the backend's code) |
| `UploadError` | `files.upload` | `ABORTED`, `PAYLOAD_TOO_LARGE`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`, `NETWORK_ERROR`, `TIMEOUT`, `UPLOAD_EXPIRED`, `INTEGRITY_FAILED` |
| `ProxyError` | `proxy.openMount` | `INVALID_ARGUMENT`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `NOT_APPROVED`, `RATE_LIMITED`, `NETWORK_ERROR`, `MALFORMED_RESPONSE`, `BOOTSTRAP_FAILED` |

All three carry a string `.code`; `UploadError`/`ProxyError` also carry `.status`
(HTTP status or `null`). Catch on `.code`, never message text.

## SDK_API_VERSION

```ts
import { SDK_API_VERSION } from "@uncorded/plugin-sdk-frontend";  // "1.1"
```

The iframe ships this in `uncorded.ready` so the shell can detect a stale iframe
HTML / SDK bundle mismatch and hard-reload both. Manifests declare a compatible
range via `api_version` (e.g. `^1.0`). MINOR bumps are additive; MAJOR bumps are
breaking and coordinated with a runtime + manifest bump.
