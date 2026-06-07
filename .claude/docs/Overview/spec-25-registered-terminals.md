---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Use anything, anytime, from anywhere — without the server holding the keys"
depends-on: [spec-03-server-container, spec-04-plugin-architecture, spec-06-authentication, spec-08-uncorded-central, spec-09-client-apps, spec-22-core-module]
last-verified: 2026-05-04
---

# 25 — Registered Terminals (Terminal Anywhere)

> **REMOVED (2026-06-05) — not a V1 feature.** The entire Terminal Anywhere / Registered
> Terminals vertical was removed as a scope reduction in commit `95dec38`
> (`chore(platform): remove Terminal Anywhere`): the runtime `terminals/*` subsystem, the
> `terminals.*` WS/IPC frame family, the `terminal.use` permission, the `cli-pair` flow,
> `apps/cli`, the `terminal-anywhere` + `echo-shell` plugins, and the website terminal
> panel/picker. This document is retained as a **historical design spec only** — it does not
> describe shipping behavior, and nothing in it should be cited as current. If the feature is
> ever revived, this spec is the starting point.

*One primitive — a "registered terminal" — with two registration sources (plugin backend, user CLI) and one attach surface (web panel, CLI, future mobile). End-to-end encrypted. The server never executes the shell; it relays opaque bytes between authenticated endpoints.*

---

## Why This Exists

Two real needs converge on the same primitive:

1. **Plugin process consoles** (the existing spec-04 case) — a Minecraft plugin needs the server admin to type `say hello` into the MC console from the web admin panel. Today this rides on `terminal.input` / `terminal.output` IPC and renders in xterm.js inside `/admin/`.
2. **Personal terminal tunnels** — a user with permission on a server should be able to run `uncorded terminal-anywhere` on their laptop, log in once via the browser, and from then on attach to **their own laptop's shell** from any device via that server. The server hosts no shell; it acts as an authenticated relay between the CLI on the user's machine and any client they attach with.

Building these as two systems would mean two protocols, two auth flows, two panel implementations, and two sets of edge cases. They are the same shape: *something registers a PTY with the runtime; something else attaches to it; the runtime gates access and relays bytes.*

**This spec defines that shared primitive.** The plugin terminal section in `spec-04-plugin-architecture.md` becomes a special case (source = `plugin`, grants by role). Terminal Anywhere is the other case (source = `user`, grants always = registering user only).

The product story is short: **"Run a server, give your friends scoped access to their own machines through it."** No centralized terminal service can offer that — the shell never lives off the user's hardware.

---

## Locked Decisions

- **One primitive: the Registered Terminal.** A record `{ id, name, source, source_id, grants, e2e_pubkey, status, created_at }` in the runtime, with a live byte-stream channel between a registrant and any number of authorized attach clients.
- **Two registration sources:** `plugin` (registered by a plugin backend over IPC) and `user` (registered by the `uncorded` CLI on a user's machine over WSS). The wire protocol differs only in the registration handshake; the relay protocol is identical.
- **One attach surface, three clients:** web panel (xterm.js), CLI (`uncorded` attach mode), future mobile. All speak the same attach protocol.
- **The server does not host shells.** A registered terminal's PTY lives wherever the registrant is — the plugin's container for `source: plugin`, the user's machine for `source: user`. The runtime relays bytes; it never spawns a shell.
- **End-to-end encryption is mandatory.** Bytes between registrant and each attach client are encrypted with a per-attach-session key derived via X25519 ECDH. The server sees only ciphertext + framing metadata. There is no opt-out. Plugin-source terminals encrypt the attach hop the same way (the in-container hop between plugin and runtime is in-process trust and stays plaintext).
- **The full PTY is routed.** stdin from any attached client, stdout/stderr from the host PTY — every byte flows. Attach clients can type; their input is merged into the host PTY's stdin alongside the host's own keystrokes. The host's local terminal is itself one of the "attached" inputs (it is the registrant's local view; remote attaches see exactly what the host sees and can type into the same shell).
- **Per-CLI pairing.** A CLI install pairs once with a user account and a single server. From then on, `uncorded terminal-anywhere` reuses the pairing. Re-pair on token revocation. v1 supports one server per CLI install; multi-server is a future refinement (code leaves hooks).
- **Permission key: `terminal.use`.** A server-level permission, off by default, grantable to roles or specific users by the owner. Required to register a `user`-source terminal. `plugin`-source terminals are gated by their own `grants` field (typically by role).
- **Server toggle: install the Terminal Anywhere plugin.** A server only allows `user`-source terminal registrations if the Terminal Anywhere core plugin is installed. Without it, `plugin`-source terminals (Minecraft console, etc.) still work — the user-tunnel feature is the opt-in part.
- **Pair flow: device-authorization via browser.** `uncorded terminal-anywhere` opens the user's browser to a Central pair URL, the user logs in (or is already logged in), picks a server from a list with status bubbles, and the CLI receives a per-(user, server, install) pair token. Headless devices use a device-code fallback (`gh auth login` style).
- **Server picker status bubbles.**
  - `✓ Plugin installed, you have permission` — selectable
  - `+ You own this server, install plugin` — one-click install + grant inline
  - `+ Plugin installed, you need permission` — disabled, hint "ask owner"
  - `✗ Not eligible` — disabled
- **Fresh-user empty state.** A user with zero servers is shown a primary CTA to download the desktop app, create a server, install the plugin, then re-run `uncorded terminal-anywhere`.
- **The host CLI is the user's interactive shell.** `uncorded terminal-anywhere` spawns a child PTY (their `$SHELL` / `$ComSpec`) and replaces stdin/stdout for that session. The user types into it normally; remote attaches see the same buffer and can type into it. On `exit`, the PTY closes, the registration is removed, and attaches are terminated cleanly.
- **The host CLI displays an attach roster.** A discreet status line shows current attached clients (`web@chrome (12m)`, `cli@phone (just now)`). On new attach, a one-line notification prints. The host can kick a session.
- **Audit logs are server-side and metadata-only.** `register`, `attach`, `detach`, `revoke`, `kick`, `disconnect_reason`, with timestamps, IP of the attaching/registering client, and durations. **No bytes are logged**, ever — the server cannot log what it cannot decrypt.
- **Permission revocation is immediate.** Removing `terminal.use` from a user, uninstalling the plugin, or banning the user terminates all that user's active relays within 1 second. The CLI reconnects only if/when permission is restored.
- **Identity binding.** The pair token is bound to `(user_id, server_id, install_id)`. Token revocation kills only that install's registrations, not the user's other installs.
- **The `terminals.*` IPC frame family (Amendment O) is the in-container transport for `plugin`-source terminals.** The plugin SDK helper (`sdk.terminals.register`) opens the IPC channel and wraps the runtime↔plugin frames in the same per-attach AES-GCM-256 cipher used on the WS attach hop. The legacy `terminal.input` / `terminal.output` IPC has been removed (Amendment P). PR-T1 left the legacy IPC dormant for the admin terminal panel; PR-T5 deletes both surfaces in favor of the unified Registered Terminals path.

---

## Threat Model

### What we defend against

- **Compromised server / malicious server admin.** Server sees ciphertext + metadata only. Cannot read terminal output, cannot inject input, cannot impersonate the host or attach clients. Mute/kick/ban (control plane) still work because they target the relay, not the bytes.
- **Compromised network path between Central and the user.** TLS protects the pair flow. The pair token never appears in URL fragments or query strings after the redirect — only in the localhost callback body.
- **Token theft from a single client.** Each pair token is bound to `(user_id, server_id, install_id)` and revocable independently. Compromise of one CLI install does not compromise others.
- **Replay / re-attach by stale clients.** Attach handshakes are nonce-protected; the per-attach session key is ephemeral (regenerated each attach).
- **Permission drift.** Server-authoritative permission checks happen on every register and every attach, plus an active broadcast on revocation that terminates open relays.

### What we do not defend against

- **Compromise of the host machine.** If the user's PC is owned, the attacker has the shell anyway. E2E does not help against endpoint compromise.
- **Compromise of an attach client device.** That device can screenshot, keylog, etc. Out of scope for transport security.
- **MITM at pair time** with a compromised Central. Mitigated by an optional fingerprint-confirmation step (host pubkey hash shown in CLI and browser, user verifies match). v1 displays the fingerprint; v2 may enforce confirmation.
- **The host machine being offline.** Terminal Anywhere is a tunnel, not a server-side persistent shell. If the host PC is off or sleeping, the terminal is unreachable. Documented in product copy.
- **Traffic-flow analysis.** The server can observe attach times, durations, byte volumes. Not a confidentiality leak, but it is a metadata leak — acceptable for the use case.

---

## The Registered Terminal Record

Stored in `core.db` (Core Module-owned table), one row per active registration. Soft-cleaned on registrant disconnect with a grace window; hard-deleted on explicit unregister or permission revocation.

```sql
CREATE TABLE registered_terminals (
  id              TEXT PRIMARY KEY,            -- ulid
  server_id       TEXT NOT NULL,
  source          TEXT NOT NULL,               -- 'plugin' | 'user'
  source_id       TEXT NOT NULL,               -- plugin slug | user_id
  install_id      TEXT,                        -- CLI install id, null for source=plugin
  name            TEXT NOT NULL,               -- 'minecraft' | 'laptop'
  display_label   TEXT NOT NULL,
  grants_json     TEXT NOT NULL,               -- {"roles": [...], "user_ids": [...]}
  e2e_pubkey      BLOB NOT NULL,               -- X25519 public key, raw 32 bytes
  status          TEXT NOT NULL,               -- 'active' | 'disconnected' | 'revoked'
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  UNIQUE (server_id, source, source_id, name)
);
```

**Naming rules.** `name` is unique per `(server_id, source, source_id)`. The CLI defaults `name` to a slug of the host's hostname; the user can override with `--name`. Plugin-registered names come from the plugin manifest's existing `processes[]` entries.

---

## Wire Protocol

All over the existing runtime WSS endpoint, MessagePack-framed. Each frame is a flat `{ type: "terminals.<op>", ...fields }` object — matching the rest of the runtime (auth, request, voice, etc.). All `<op>` values are listed below.

### Registration (user source)

```
CLI → server      register.req      { source, install_id, pair_token, name, display_label, e2e_pubkey }
server → CLI      register.ack      { terminal_id, accepted_grants }
                  register.nak      { code, message }
```

The `pair_token` is bound to `(user_id, server_id, install_id)`. The runtime checks `terminal.use` permission, persists the row, and broadcasts `terminals.list_changed` on the server's standard event topic (so panels and other clients refresh).

### Registration (plugin source)

The plugin SDK exposes:

```ts
const term = await runtime.terminals.register({
  name: "minecraft",
  label: "Minecraft Server",
  grants: { roles: ["owner", "admin"] },
  pty: { stdin, stdout },           // streams the plugin pipes
  e2e_pubkey,                       // generated by the plugin's runtime helper
});
```

This compiles to a `register.req` over IPC with `source: "plugin"`. The runtime treats the plugin's pipes as the host PTY for that registration.

### Attach

```
client → server   attach.req      { terminal_id, attach_pubkey, attach_random }
server → host     attach.invite   { session_id, attach_pubkey, attach_user_id, attach_random }
host → server     attach.confirm  { session_id, confirmed }
server → attach   attach.ready    { session_id, host_pubkey }
```

**(Amendment I, 2026-05-04 — applies in PR-T4.)** Three drifts in the attach handshake that PR-T1 shipped differently from earlier spec drafts:

- `attach.invite` carries the **attach client's** ephemeral pubkey (`attach_pubkey`), not the host's. The host needs the attaching peer's pubkey to derive the ECDH shared secret. Field set matches the canonical type at `packages/protocol/src/index.ts:177-183`. The `attach_user_id` lets the host know which user's session is being requested.
- `attach.ready` carries `host_pubkey` (the host's long-lived X25519 raw pubkey, 32 bytes). The attach client verifies its truncated SHA-256 fingerprint matches the `fingerprint` returned by `terminals.list` for this terminal (Amendment M). Mismatch → tear down with a fingerprint-mismatch error.
- The `nonce` / `attach_nonce` field is renamed to `attach_random` on the wire. It is a per-direction random used to derive the per-session crypto context (Amendment L), not a per-frame AES nonce — the prior name was misleading. Wire bytes unchanged; the rename is TypeScript-only.
- The PR-T1 reservations `attach.confirm.host_nonce` and `attach.ready.host_nonce` are **removed**. Per Amendment L the per-direction random for AES nonces is generated and kept locally by each sender; it is not exchanged. The host instead embeds its own per-direction random in the high-order bytes of every frame's nonce.

`attach_pubkey` is the attach client's ephemeral X25519 raw pubkey (32 bytes). Both ends compute the ECDH shared secret as `X25519(our_priv, their_pub)` and derive the AES-GCM-256 session key via HKDF-SHA256 (Amendment K).

Once `attach.ready` lands, the attach client and host begin exchanging encrypted payloads:

```
host  → server → attach    pty.bytes  { session_id, ciphertext, nonce }
attach → server → host     pty.input  { session_id, ciphertext, nonce }
```

The server validates `(session_id, terminal_id, user_id)` on every frame and forwards opaque ciphertext. It does not decrypt.

**(Amendment J, 2026-05-04 — applies in PR-T4.)** The byte-stream and lifecycle frames change as follows:

- **`terminals.pty.bytes` is session-keyed:** `{ session_id, ciphertext, nonce }`. The host emits one frame per attached session, encrypted under that session's AES-GCM-256 key. The runtime routes by `session_id` to exactly one attach socket. PR-T1 keyed it by `terminal_id` and broadcast the same plaintext payload to every attach (`runtime/src/terminals/relay.ts:21` `forwardPtyBytes`); with per-session encryption broadcast is no longer possible — each attach has its own AES-GCM key.
- **`terminals.pty.input` is also ciphertext + nonce:** `{ session_id, ciphertext, nonce }` — already session-keyed in PR-T1; only the field rename `payload → ciphertext` plus the new `nonce` field changes.
- **`terminals.pty.resize` is session-keyed:** `{ session_id, cols, rows }` — stays plaintext (resize values are inferable from any UI screenshot and don't justify per-frame crypto). PR-T1 keyed it by `terminal_id`; PR-T4 changes the routing key to `session_id` so the runtime can scope a resize to one attach.
- **The reconnect ring-buffer scrollback feature is REMOVED** in PR-T4. Backfill of pre-attach output is incompatible with per-session keys: the host would have to re-encrypt every buffered byte under each new attach's key on every join, which is both expensive and surprising. Late-attaching clients see only output produced after their `attach.ready`. Future work may reintroduce a host-side on-demand replay request, but that is out of scope here. The "Reconnect ring buffer size" row in §Resource Limits and Defaults (originally 64 KB / terminal) is dropped.
- **Drift cleanup folded into this amendment:** §Wire Protocol line 109 (`register.req`) is corrected from `{ name, e2e_pubkey, install_id, pair_token }` to `{ source, install_id, pair_token, name, display_label, e2e_pubkey }` to match `WsTerminalsRegisterReq` at `packages/protocol/src/index.ts:133-145`. The `attach.confirm` and `attach.ready` lines are corrected by Amendment I above. These are fixes to PR-T1 prose, not new design decisions; reviewers can verify each by diffing the spec line against `packages/protocol/src/index.ts`.

### Lifecycle and control

```
host → server     pty.resize        { session_id, cols, rows }      // Amendment J: session-keyed
host → server     terminal.kick     { session_id }                  // server forces an attach detach
client → server   terminal.detach   { session_id }
server → all      terminal.revoked  { terminal_id, reason }         // permission/uninstall cascade
server → host     attach.joined     { session_id, attach_meta }
server → host     attach.left       { session_id, reason, duration_ms }
```

### Heartbeat

Both registrant and attach clients send a `ping` every 20s. Server marks `disconnected` after 30s silence. Registrant reconnect within 5 minutes restores the same `terminal_id` (token-bound). After 5 minutes of registrant absence, the row is removed and attaches are torn down.

---

## End-to-End Encryption

- **Algorithm.** X25519 ECDH for key agreement, AES-GCM-256 for AEAD (Amendment K). HKDF-SHA256 for key derivation.
- **Host keypair.** Generated at first `terminal-anywhere` invocation per CLI install, stored in the OS-backed secret store (`Bun.secrets` — same one the desktop app uses for tokens, see `spec-09`). Long-lived; one keypair per install, not per registration.
- **Plugin host keypair.** Generated in-process by the plugin SDK helper; lives only in plugin memory. Acceptable because the in-container hop is plaintext anyway and the keypair never leaves the runtime+plugin trust boundary.
- **Per-attach session.** Attach client generates an ephemeral X25519 keypair, sends its public key in `attach.req`. Host derives session key via `X25519(host_priv, attach_pub)`, attach derives via `X25519(attach_priv, host_pub)`. Independent session per attach client.
- **Frame format.** Wire frame = `{ session_id, ciphertext, nonce(12) }` (per Amendment J). The 16-byte AES-GCM authentication tag is appended to the ciphertext as standard WebCrypto output.
- **Fingerprint surface.** CLI prints `Fingerprint: <8-byte-truncation-base32>` on first registration. The server picker browser shows the same fingerprint as `RegisteredTerminalSummary.fingerprint` (`packages/protocol/src/index.ts:1034`). PR-T4 makes the fingerprint security-load-bearing — see Amendment M.

**(Amendment K, 2026-05-04 — applies in PR-T4.)** PR-T4 swaps the AEAD from ChaCha20-Poly1305 to AES-GCM-256 and pins the KDF:

- **AEAD:** AES-GCM-256. Universally supported by `crypto.subtle.encrypt` / `decrypt` in every target browser and by Bun's WebCrypto. Hardware-accelerated (AES-NI / ARMv8 Crypto Extensions) on every platform UnCorded targets. Authentication tag is 128 bits, appended to the ciphertext as standard WebCrypto output. ChaCha20-Poly1305 is **not** in the W3C WebCrypto spec — neither Chromium, Firefox, nor Safari expose it via `crypto.subtle`. Bun and Node ship it via libsodium-style bindings, but the browser attach client cannot use it without a 30+ KB JS polyfill, which violates the bundle budget set in PR-T3.
- **KDF:** HKDF-SHA256 over the raw 32-byte ECDH shared secret. `salt = sha256(session_id_utf8)` (full 32 bytes). `info = "uncorded.terminal.session.v1"`. Output is a 32-byte AES-256 key. Compute once per session at `attach.ready` time on both ends; no rotation within a session.

**(Amendment L, 2026-05-04 — applies in PR-T4.)** Nonce construction and replay protection:

- **Nonce (12 bytes, AES-GCM standard):** `counter_be(8) || session_random(4)`. `session_random` is 4 random bytes generated locally at session start by each *sender* (host generates one for host→attach; attach generates one for attach→host). It is NOT exchanged on the wire — both ends embed their random in every frame they send, and the receiver simply verifies the counter is strict-monotonic. The 4-byte random ensures host→attach and attach→host nonce spaces never collide even at the same counter value, and ensures two attaches to the same terminal can't produce identical nonces under different keys.
- **Counter:** Big-endian uint64, starts at 0, increments by 1 per encrypted frame *sent on this session in this direction*. The receiver tracks `last_counter` per (session, direction) and rejects any frame whose counter is ≤ `last_counter`. At ~10 MB/s sustained throughput with 4 KB frames, exhaustion takes ~234,000 years. No counter-wrap handling needed.
- **AAD:** `sha256(session_id_utf8)[0..16] || direction_byte`. `direction_byte` is `0x01` for host→attach, `0x02` for attach→host. AAD binds every frame to its (session, direction), so a frame replayed across sessions or across directions fails AEAD verification. The 16-byte session digest avoids paying for a full 32-byte hash on every frame.
- **Replay-cache shape:** none. Strict-monotonic counter + (session, direction)-binding AAD is sufficient for the in-order WebSocket transport. No sliding window, no per-message bloom.

**(Amendment M, 2026-05-04 — applies in PR-T4.)** `e2e_pubkey` enforcement and fingerprint as trust anchor:

- **`register.req.e2e_pubkey` is mandatory and validated for `source: "user"`.** The runtime rejects `register.req` with a missing, zero-filled, or non-32-byte `e2e_pubkey` when `source === "user"`. Plugin-source registrations (`source: "plugin"`, lands in PR-T5) may continue to send a zero-filled value; their trust boundary is the server runtime, not an end-to-end key. Rejection sends `register.nak { code: "invalid_payload", message: "register requires non-zero 32-byte e2e_pubkey for user source" }` and closes the WS with `WS_CLOSE_POLICY_VIOLATION`. The runtime logs `{user.id, install_id, connectionId}` (which `handleRegister` already has in scope at `runtime/src/terminals/handshake.ts:96-100`) for triage.
- **Picker `fingerprint` is the trust anchor.** The `RegisteredTerminalSummary` already exposes `fingerprint` (`packages/protocol/src/index.ts:1034`), derived as the first 8 bytes of `sha256(e2e_pubkey)` rendered in dash-grouped base32. The attach client compares it against `fingerprint(host_pubkey from attach.ready)`. Mismatch → permanent terminal state `fingerprint_mismatch` (joins `revoked` as a permanent state); attach tears down without sending or accepting any encrypted frames.

**(Amendment N, 2026-05-05 — applies in PR-T5.)** Plugin-source attach hop is now end-to-end encrypted, supersedes the Amendment M carve-out:

- **`register.req.e2e_pubkey` is mandatory and validated for both sources.** The PR-T4 carve-out in Amendment M ("`source: "plugin"` may continue to send zero-filled") is REMOVED. Plugin-source registrations now MUST send a non-zero 32-byte X25519 raw pubkey, generated in plugin process memory by the SDK helper introduced in Amendment O. The runtime rejects plugin-source registrations the same way it rejects user-source ones — `register.nak { code: "invalid_payload" }` + `WS_CLOSE_POLICY_VIOLATION` for the WS path, and an analogous IPC error for the in-container registration path. This realigns the runtime with the §Locked Decisions block, which always specified plugin-source as encrypted on the attach hop.
- **In-container hop stays plaintext.** Per §Locked Decisions, the runtime↔plugin IPC channel is in-process trust and does not encrypt. The plugin process is the host endpoint of the AEAD: it owns the host private key, performs the ECDH derivation, and produces ciphertext frames that the runtime forwards opaquely to attach clients. The runtime never holds plaintext PTY bytes for either source.
- **Plugin host keypair is ephemeral per process.** Generated by `sdk.terminals.generateHostKeypair()` (or implicitly by `sdk.terminals.register({...})` if the plugin doesn't pass one). Lives only in plugin memory. On plugin restart a new keypair is generated; the registration is re-issued with the new pubkey, and any attached clients see a `fingerprint_mismatch` on reconnect — the same trust-anchor flow user-source uses. Plugins that need a stable fingerprint across restarts may persist their JWK to their own SQLite via the `kv` API, but the recommended posture is ephemeral.
- **Picker label.** Plugin-source rows in `terminals.list` are labeled "(plugin host)" in the picker UI to communicate that the trust anchor is the plugin process, not user-controlled hardware. The fingerprint UX is identical for both sources.

**(Amendment O, 2026-05-05 — applies in PR-T5.)** Plugin SDK shape and runtime↔plugin IPC frames:

- **SDK surface.** `@uncorded/plugin-sdk` exposes a `terminals` namespace on the `PluginHandle` returned by `createPlugin()`:

  ```ts
  const term = await sdk.terminals.register({
    name: "minecraft",          // unique per (server_id, source, source_id); spec-25 §Naming rules
    label: "Minecraft Server",  // human-friendly display
    grants: { roles: ["owner", "admin"], userIds: [] },
    pty: { stdin, stdout },     // plugin-side streams; data on stdout becomes pty.bytes
    // hostKeypair is optional; sdk.terminals generates one with sessionCipher.generateHostKeypair() if omitted
  });
  // returns: TerminalsHandle { terminalId, fingerprint, resize(cols, rows), kick(sessionId), unregister() }
  ```

  Internally the SDK wraps `sessionCipher.HostSessionCipher` from `@uncorded/protocol`. On `attach.invite` from the runtime, the SDK derives a per-attach session key, listens for `pty.input` ciphertext, decrypts and writes to `pty.stdin`, and conversely encrypts every chunk read from `pty.stdout` into `pty.bytes` ciphertext frames. The SDK serializes encrypts per session via the same promise chain `HostSessionCipher` already uses.
- **Runtime↔plugin IPC frames.** New IPC message types in `packages/protocol/src/index.ts`, mirroring the WS shapes byte-for-byte except they ride the stdio JSON transport instead of MessagePack/WS:
  - Plugin → Runtime: `terminals.register.req` (with `source: "plugin"`, no `pair_token` — gated by plugin manifest grants instead), `terminals.attach.confirm`, `terminals.pty.bytes`, `terminals.pty.resize`, `terminals.unregister`.
  - Runtime → Plugin: `terminals.register.ack` / `terminals.register.nak`, `terminals.attach.invite`, `terminals.pty.input`, `terminals.kick`, `terminals.attach.left`.

  The runtime relays the WS attach hop frames to/from the plugin IPC unchanged — same `session_id`, same `ciphertext`, same `nonce`. The runtime is a router on both sides of itself, never a peer.
- **Capability gating.** Plugins that call `sdk.terminals.register` must declare `"terminals.register"` in their manifest's `permissions` array; the runtime rejects unsolicited `terminals.register.req` IPC frames otherwise. The IPC dispatch path in `runtime/src/ws/router.ts` adds `"terminals.register.req"` and the related plugin terminals frames to the capability check; only `"terminals.pty.bytes"`, `"terminals.pty.input"`, `"terminals.attach.confirm"`, etc. ride PASSTHROUGH for active sessions of an already-registered terminal.

**(Amendment P, 2026-05-05 — applies in PR-T5.)** Legacy `terminal.input` / `terminal.output` IPC + WS removed:

- **§Locked Decisions correction.** The line *"Existing `terminal.input` / `terminal.output` IPC remains valid as the in-container transport for `plugin`-source terminals"* is amended to: *the new `terminals.*` IPC frame family (Amendment O) is the in-container transport for `plugin`-source terminals*. The legacy frames are deleted entirely.
- **Removed surfaces.** PR-T5 deletes `TerminalInputMessage` / `TerminalOutputMessage` (`packages/protocol/src/index.ts:73-78` + `:110-115`) and `IpcTerminalInputMessage` / `IpcTerminalOutputMessage` (`:372-382`). Removes the `TerminalInputMessageSchema` / `TerminalOutputMessageSchema` and their tests (`packages/protocol-schemas/src/index.ts:55-90` + the corresponding fixture cases). Removes the `terminal.input` parser case (`runtime/src/ws/router.ts:167-180`), the `handleTerminalInput` / `handleTerminalOutput` methods (`:1237-1298`), the `terminalSubscriptions` map (`:303` + cleanup at `:478`), the dispatch case (`:625`), the plugin-side `terminal.output` passthrough (`:669-675`), and the PASSTHROUGH list entry at `:1572`. Deletes the legacy admin terminal panel at `runtime/admin/app.js:315-440`. Removes the `"terminal.input"` branch in `apps/website/src/components/channel-view.tsx:351`.
- **Tests removed.** `runtime/src/ws/router.test.ts:661-770` (4 cases) and the legacy terminal cases in `runtime/src/ws/server.test.ts`. Replaced by new SDK-level tests at `packages/plugin-sdk/src/__tests__/terminals.test.ts` and runtime relay tests at `runtime/src/terminals/plugin-bridge.test.ts`.
- **No backwards-compat.** PR-T1/T2/T3/T4 shipped behind the public-release gate (closed by PR-T4); no production users exist to migrate. Plugins shipping today (none use `terminal.input/output` outside the dormant admin path) are unaffected.

---

## CLI

### `uncorded terminal-anywhere`

The headline command. Opens an interactive PTY that is also remotely attachable.

```
$ uncorded terminal-anywhere
→ Opening browser to pair this terminal with a server...
→ Visit: https://central.uncorded.app/cli/pair?code=ABCD-1234
→ Waiting for pairing... (Ctrl-C to cancel)

✓ Paired with server: homelab.example
✓ Terminal registered: laptop
  Fingerprint: 3HKD-RZQ9-7BNW

📎 No clients attached. Type as normal — your shell is now reachable.
$ █
```

Subsequent invocations on the same install reuse the pairing:

```
$ uncorded terminal-anywhere
✓ Reusing pairing: homelab.example
✓ Terminal registered: laptop-2

📎 Attached: web@chrome on Pixel 8 Pro (just now)
$ █
```

#### Flags (v1)

- `--name <name>` — override the terminal name (default: derived from hostname).
- `--label <label>` — human label shown in pickers (default: same as name).
- `--no-browser` — force the device-code fallback (print URL + 8-char code).
- `--re-pair` — discard existing pairing and re-pair.
- `--unpair` — remove pairing without launching a terminal.

#### Flags (planned, comments-only in v1 code)

- `--server <slug>` — select among multiple paired servers (multi-server is future).
- `--account <email>` — select among multiple paired accounts (multi-account is future).

### Pair Flow Detail

1. CLI does NOT generate `install_id` — the runtime mints it during step 8's `POST /terminals/pair` and returns it in the bundle. CLI persists what the runtime returns. (Amendment D, 2026-05-04: corrects an earlier draft that had the CLI minting `install_id`. Server-side minting lets the pair-token store bind `install_id` to a concrete row at issuance time.)
2. CLI generates an X25519 keypair if absent; persists private key in OS secret store, retains pubkey for `register.req` (PR-T4 enforces).
3. CLI generates a random `device_code` (32 bytes, hex) and a `pair_code` (8 chars, base32, dash-grouped) — both cryptographically random, neither persisted past this pair attempt.
4. CLI POSTs `{pair_code, device_code_hash:sha256(device_code)}` to `https://central.uncorded.app/v1/cli/pair/init`. Central stores `{pair_code, device_code_hash, status:"pending", created_at}` in a 10-min KV.
5. CLI opens browser to `https://central.uncorded.app/cli/pair?code=<pair_code>` (no port, no secret in URL). With `--no-browser`, CLI prints the URL + `pair_code` for headless devices to open elsewhere.
6. CLI displays `pair_code` on stdout so the user can verify the browser shows a matching value before selecting (anti-phishing).
7. CLI polls `POST /v1/cli/pair/poll {device_code, pair_code}` every 3s. The raw `device_code` is the bearer secret authorizing the poll; Central compares `sha256(device_code)` against the stored hash with `timingSafeEqual`.
8. Browser shows `pair_code` + the server picker scoped to servers the user is on with status bubbles per §Permission gates. If plugin not installed and user is owner, inline install completes first.
9. User picks a server. Browser POSTs `{pair_code, server_id}` to `/v1/cli/pair/select` with the user's session cookie. Central acts as a **synchronous middleman**: mints a runtime JWT scoped to (user_id, server_id) via the existing `serverTokenSigner`, calls `POST {server.tunnel_url}/terminals/pair` itself with that JWT, receives `{install_id, pair_token, expires_at}` (the runtime mints `install_id`; see step 1). Central writes the bundle into the KV entry and creates a `cli_installs` row.
10. Next CLI poll returns the bundle `{server_url, server_id, server_name, install_id, pair_token, server_token_jwt, server_token_jwt_expires_at, refresh_token}`. Central does NOT delete the KV entry on first read — see step 12 (Amendment E).
11. CLI persists `refresh_token` to OS secret store, persists install metadata to `cli.json`, opens WSS to `server_url`, sends `terminals.register.req` with `pair_token` + a SECOND server-token JWT minted by Central in step 9 (the JWT used for Central's HTTP POST has its `jti` burned by the runtime, so a different JWT is required for WS auth — see §Wire Protocol).
12. **(Amendment E — KV grace window.)** The KV entry is NOT deleted on first read. Instead, when the CLI confirms receipt by calling `POST /v1/cli/pair/ack {pair_code, device_code}`, the entry is deleted. If the CLI never acks (TCP died mid-bundle-receive), the entry expires naturally at the 10-min TTL. Polls after `ack` return `{status:"consumed"}`. This avoids losing a successful pair to a transient network blip mid-response.

**Why polling, not loopback (rationale for the change from earlier drafts).** The earlier draft used a loopback callback flow: CLI binds a localhost port, browser POSTs the bundle to `http://127.0.0.1:<port>/callback`, with an out-of-band `pair_secret` paste-confirm to mitigate a malicious local app racing for the port. Polling sidesteps two unfixable real-world problems: (a) the malicious-local-app race the prior spec called out itself — fundamentally awkward to mitigate without OOB confirmation; (b) Windows firewall + captive-portal hostility toward inbound `127.0.0.1` binds. With polling, all traffic is outbound from the CLI, `device_code` is the bearer authorizing each poll, and the bundle never appears in any URL — only `pair_code` does.

### `uncorded attach <terminal>`

Attaches to a terminal (the registrant's or one the user has been granted). Renders xterm-equivalent in the local terminal. Same E2E handshake.

### `uncorded terminals list`

Lists terminals the user can see on the paired server (their own + any plugin-source terminals they have grants on).

### `uncorded terminals kick <session>`

Host-only. Forces an attached client off.

### Per-CLI install pairing (refresh)

A `cli_installs` row on Central is the spine of "per-CLI install pairing." Created when the CLI completes its first pair flow. Stores `{install_id, account_id, server_id, refresh_token_hash, name, created_at, last_used_at, revoked_at}`.

The CLI persists a long-lived `refresh_token` in the OS secret store (`Bun.secrets`). On subsequent invocations, the CLI calls `POST /v1/cli/install/refresh {install_id, refresh_token}` and receives a fresh runtime server-token JWT (10-min TTL) plus the server's current `tunnel_url`. The refresh endpoint is rate-limited **30/hour/install** (sized to absorb WS exponential backoff on flaky links — happy-path uses ~6/hour at 10-min JWT TTL). User-driven revocation marks `revoked_at`, terminating future refreshes; in-flight relays are torn down by the existing PR-T1 cascade `core.token.revoked` topic.

**`refresh_token` generation:** Central generates `refresh_token = base64url(crypto.getRandomValues(32 bytes))` once during `/v1/cli/pair/select`, returns the raw value in the bundle exactly once, and persists `refresh_token_hash = sha256(refresh_token)` (hex) in `cli_installs`. Validation on `/v1/cli/install/refresh` recomputes `sha256(provided)` and `timingSafeEqual`s against the stored hash. Raw value is never stored on Central.

### Cross-platform PTY

- **Linux / macOS:** standard `openpty(3)`.
- **Windows:** ConPTY (Windows 10 1809+). PowerShell, cmd.exe, or WSL bash all work.
- **Implementation:** use a battle-tested library (`portable-pty` if Rust, `creack/pty` if Go, `node-pty` if Node). No bespoke PTY layer.
- **Default shell:** `$SHELL`, fall back to `/bin/sh`. Windows: `$env:ComSpec`, fall back to `cmd.exe`.

---

## Web Panel: Terminal Panel Type

A new panel type in the workspace (see `spec-22-core-module.md` workspace layout): `terminal`. The panel content is an xterm.js attached to a registered terminal.

- **Picker UX.** When the user adds a Terminal panel, the runtime returns the list of terminals the user has grants for on the current server. Empty state shows "No terminals here yet. Run `uncorded terminal-anywhere` on the machine you want to attach, or ask an admin to grant you `terminal.use`."
- **Picker transport (Amendment G, 2026-05-04).** `GET {tunnel_url}/terminals` returns `{terminals: [{terminal_id, name, display_label, source, source_id, status, fingerprint, created_at, last_seen_at}]}` for the authenticated user — gated by `terminal.use` permission like `POST /terminals/pair` is. Same Bearer-JWT auth as the rest of the runtime HTTP layer (see `runtime/src/http/auth.ts`). The list reflects only `status IN ('active','disconnected')` rows the user holds grants on. Rate-limited at the standard `RATE_WORKSPACE` shape (60/min/user). The picker re-fetches lazily on panel open and on every `terminals.list_changed` event the WS already broadcasts (see §Wire Protocol). Why HTTP and not a WS request frame: the picker is opened from the panel-add menu, before any terminal-specific WS subscription exists; a request/response WS shape would force a control channel that doesn't otherwise exist for terminals (the existing terminals.* frames are all stream-oriented). HTTP also makes the empty-state polish trivially cacheable in an HTTP store.
- **Attach (plaintext, PR-T3).** Web client reuses the existing per-server WSS opened by the workspace shell for plugin frames. Auth on that WSS is a server-token JWT minted by Central (`/v1/server-token`) and passed as the first MessagePack `{type:"auth", token}` frame — see the auth-handshake header comment at `apps/website/src/lib/ws.ts:1` and the send site near `apps/website/src/lib/ws.ts:499`. There is no cookie auth on the runtime; everything is Bearer-JWT (`runtime/src/http/auth.ts`). It generates a *zero-filled* `attach_pubkey` and `nonce` (the runtime accepts but ignores both — see PR-T1's frame parser at `runtime/src/ws/router.ts:205-218`). The full attach handshake (`attach.req` → `attach.invite` → `attach.confirm` → `attach.ready`) runs as documented in §Wire Protocol; on `attach.ready` the panel begins exchanging plaintext `pty.bytes`/`pty.input` payloads.
- **Attach (E2E, PR-T4).** Replaces the zero-filled keypair with a non-extractable WebCrypto X25519 keypair, derives the per-attach session key via X25519 ECDH + HKDF-SHA256 (Amendment K), and switches `payload` framing to `{ session_id, ciphertext, nonce(12) }` AES-GCM-256 (Amendments J + K). Same wire shape as the CLI; cipher parameters live in §End-to-End Encryption. The picker `fingerprint` becomes security-load-bearing — the panel verifies the host pubkey from `attach.ready` against it (Amendment M) and renders a "host identity changed" overlay on mismatch instead of attaching.
- **Resize.** xterm.js fit addon → `pty.resize` over the relay → host PTY `ioctl`. All other attaches follow the new dimensions.
- **Disconnect.** On panel close, send `terminal.detach` cleanly.
- **Reconnect.** If the host disconnects mid-session, the panel shows a "host unreachable, retrying…" overlay and reconnects automatically when the host returns.
- **Read-only mode (future).** Same panel, but suppress input. Useful for shoulder-watching. Out of scope for v1.

**`PanelContent` discriminated union extension (Amendment H, 2026-05-04).** The canonical `PanelContent` union in `packages/protocol/src/core.ts` resolves to `{type:"plugin"} | LegacyBrowserPanelContent | TabbedBrowserPanelContent` (the latter two share a `type:"browser"` discriminator). PR-T3 extends it with a third discriminator value `"terminal"` alongside the existing `"plugin"` and the `BrowserPanelContent` sub-union:

```ts
| {
    type: "terminal";
    serverId: string;
    tunnelUrl: string;
    terminalId: string;
    name: string;             // immutable display name from registration
    displayLabel: string;     // human-friendly label, falls back to name
    source: "user" | "plugin";
  }
```

The variant is persisted into the user's saved workspace layout exactly like browser/plugin panels are. On layout restore the panel attempts to re-attach; if the terminal_id has been revoked / the host is down, the panel renders the standard "host unreachable, retrying…" overlay and polls the picker endpoint until the terminal reappears or the user closes the panel.

**Release gate (Amendment F, 2026-05-04):** PR-T3 ships the panel relay in plaintext per the PR-T1/PR-T4 split. Do not ship PR-T3 to public user installs without PR-T4 also in main. Local dev / smoke testing of PR-T3 over plaintext is allowed — same gate language as Amendment C (PR-T2).

The existing `/admin/` xterm.js for plugin terminals (per `spec-04`) becomes a thin wrapper over the same panel — the only difference is the picker is filtered to `source: plugin` terminals.

---

## Permission and Cascade Model

- **`terminal.use`** is a new server permission, defined in the Core Module's permission registry. Default-grantable to no role; owner explicitly grants.
- **Plugin terminal grants** continue to use the existing role gates (per `spec-04`, owner/admin only by default; plugins may declare custom role grants).
- **Cascade triggers** (any of these terminate matching active relays within 1s, audit-logged):
  - `terminal.use` revoked from user → terminate user's `source: user` terminals.
  - User banned from server → terminate all of their relays (registrant or attach).
  - Terminal Anywhere plugin uninstalled → terminate all `source: user` registrations on that server.
  - Plugin uninstalled → terminate that plugin's registrations.
  - Pair token revoked → terminate that install's registrations.
  - Server stopped → terminate all relays (graceful where possible).

The cascade is implemented as a single subscriber on the existing core event bus: `core.permission.changed`, `core.user.banned`, `core.plugin.lifecycle`, `core.token.revoked`, `core.server.lifecycle` → `terminals.cascade.evaluate`.

---

## Resource Limits and Defaults

| Limit | Default | Configurable by |
|---|---|---|
| Concurrent terminals per user per server | 5 | Server owner |
| Concurrent attaches per terminal | 3 | Server owner |
| Idle (no input/output) timeout | 60 min | Server owner |
| Reconnect grace window for registrant | 5 min | Hard-coded v1 |
| Pair-flow window | 5 min | Hard-coded v1 |
| Max attach handshakes/sec per user | 10 | Hard-coded v1 (rate-limited) |

> The PR-T1 "Reconnect ring buffer size (64 KB / terminal)" row was dropped by Amendment J — the ring-buffer scrollback feature is removed in PR-T4 because per-session encryption makes per-attach re-encryption of buffered bytes prohibitively expensive. Late-attaching clients see only output produced after their `attach.ready`.

All limits emit metrics; rejection reasons appear in audit log and CLI/panel UI.

---

## Audit Log

Logged to `core.db` audit table (existing infrastructure). Metadata only — never bytes.

| Event | Fields |
|---|---|
| `terminal.registered` | `id, source, source_id, name, install_id, ip, ts` |
| `terminal.unregistered` | `id, reason, duration_ms, ts` |
| `terminal.attached` | `terminal_id, session_id, user_id, client_kind, ip, ts` |
| `terminal.detached` | `session_id, reason, duration_ms, bytes_in, bytes_out, ts` |
| `terminal.kicked` | `session_id, by_user_id, ts` |
| `terminal.revoked` | `terminal_id, cascade_source, ts` |
| `terminal.permission_denied` | `user_id, terminal_id, reason, ts` |

Owner-visible in admin panel. Filterable by user, terminal, time range. Retained per the existing audit-log retention policy.

---

## Build Sequence

Phased PRs, each independently shippable and reviewable.

| PR | Scope | Verifies |
|---|---|---|
| **PR-T0** (this) | Vault spec lands and is reviewed | Design alignment |
| **PR-T1** | Runtime: registration, relay, permission gate, cascade, audit. No CLI, no panel. Tested via raw WSS scripts. | Server-side primitive works |
| **PR-T2** | CLI: `uncorded terminal-anywhere`, pair flow (browser + device-code), PTY child shell, attach roster, kick. Pair endpoint on Central. Server picker UI in browser pair page. | End-to-end on developer's box |
| **PR-T3** | Web Terminal panel (xterm.js), picker, attach. Status bubbles in server picker polished. | Multi-device attach |
| **PR-T4** | E2E encryption layer wired through PR-T1/T2/T3. Fingerprint display. | Server cannot read bytes |
| **PR-T5** | Plugin SDK wrapper (`runtime.terminals.register`). Migrate existing `terminal.input/output` IPC path to be the implementation of `source: plugin`. Minecraft proof-of-concept plugin. | spec-04 case folded in cleanly |
| **PR-T6** | Resource limits enforcement, admin grant UI (`terminal.use`), audit-log viewer in admin panel, fresh-user empty state polish, install-plugin-inline flow in pair page. | Production-grade ops |

E2E (PR-T4) is sequenced **after** the relay works in plaintext to keep PR-T1 reviewable. PR-T4 is mandatory before any external announcement of the feature.

**Release gate (Amendment C, 2026-05-04):** PR-T2 ships the relay in plaintext per the PR-T1/PR-T4 split. Do not ship PR-T2 to public user installs without PR-T4 also in main. Local dev / smoke testing of PR-T2 over plaintext is allowed.

**Release gate (Amendment F, 2026-05-04):** PR-T3 ships the panel relay in plaintext, matching the PR-T2 gate. The full Amendment F text — with the protocol detail of the plaintext attach — lives in §Web Panel: Terminal Panel Type. Do not ship PR-T3 to public user installs without PR-T4 also in main. Local dev / smoke testing of PR-T3 over plaintext is allowed.

---

## Performance Budgets

- **Attach handshake:** under 250ms p95 from `attach.req` to `attach.ready` on a regional connection.
- **Keystroke latency added by relay:** under 30ms p95 on a regional connection (server-side processing only — does not include WAN RTT).
- **Idle terminal cost:** under 256 bytes/min of WSS traffic per terminal (heartbeats only).
- **Server memory per active terminal:** under 128 KB resident (ring buffer + state).
- **CLI cold start to ready prompt:** under 800ms on the cached pairing path.

These are aspirational targets for the spec; PR-T6 measures actual numbers and locks them in.

---

## Summary of Decisions

| Decision | Answer |
|---|---|
| Primitive | Single Registered Terminal record; two registration sources, one attach surface |
| Where the shell lives | On the registrant — plugin's container or user's PC. Server hosts no shells. |
| Encryption | Mandatory E2E (X25519 ECDH + HKDF-SHA256 + AES-GCM-256, Amendments K-M), per-attach session keys |
| Routing | Full PTY (stdin from any attach merges into host stdin; stdout/stderr fan out to all attaches) |
| CLI command | `uncorded terminal-anywhere` — interactive shell, opens browser pair flow |
| Pair flow | Browser device-authorization with localhost callback; device-code fallback for headless |
| Pair scope | Per CLI install, single server in v1 (multi-server is a future refinement, code leaves hooks) |
| Server picker | Status bubbles: ✓ ready / + install plugin / + need permission / ✗ ineligible |
| Fresh-user empty state | Prompt to download desktop app, create server, install plugin, retry |
| Permission key | `terminal.use` — server-level, off by default, owner-grantable to roles or specific users |
| Server feature toggle | Owner installs the Terminal Anywhere plugin to allow `source: user` registrations |
| Plugin terminals (spec-04 case) | Re-implemented as `source: plugin` registrations; existing `terminal.input/output` IPC is the in-container transport |
| Permission cascade | Permission revoke / ban / uninstall terminates relays within 1s, audit-logged |
| Audit | Server-side, metadata only, never bytes |
| Resource limits | 5 terminals/user/server, 3 attaches/terminal, 60min idle, 64KB reconnect buffer |
| PTY library | Battle-tested (portable-pty / creack-pty / node-pty); ConPTY on Windows |
| Reconnect | Registrant 5-min grace; ring-buffer for short attach drops; exponential backoff |
| Trust at pair time | Fingerprint shown CLI-side and browser-side, informational v1, optional enforced v2 |

---

## Future Refinements

### Multi-server pairing per CLI install
- **What changes:** `uncorded terminal-anywhere --server <slug>` selects among multiple paired servers; pairings stored as a list keyed by server.
- **Why not now:** v1 keeps the model simple — one identity per CLI install, one server. Solo dev verification, security review, and UX testing all collapse to one path.
- **What today's code must not do:** Do not store the pair token in a single-record schema. Use a list-of-pairings shape from day one (with `(install_id, account_id, server_id)` composite key) so multi-server is additive, not migrating. Mark single-server assumptions with `// TODO(multi-server)` comments at every branch.

### Multi-account on one CLI install
- **What changes:** A user with both work and personal UnCorded accounts can pair both into the same CLI install and select per-invocation.
- **Why not now:** Edge case for v1 audience (homelab/gaming). Account-switching UX needs care to avoid token confusion.
- **What today's code must not do:** Pair tokens are stored keyed by `account_id`, not as a singleton. The OS secret store layout from day one is `uncorded.cli.pairs.<account_id>.<server_id>` so multi-account is a UI change, not a schema migration.

### Enforced fingerprint confirmation
- **What changes:** v2 gates `register.ack` on the user clicking "I confirm this fingerprint matches my CLI" in the browser. Mitigates compromised-Central MITM at pair time.
- **Why not now:** UX friction for a threat that is not v1's primary concern (the wedge audience trusts Central for now). v1 displays the fingerprint informationally.
- **What today's code must not do:** Treat the fingerprint as a UI-only string. It must be derived from the actual key and reproducible on both ends so v2 enforcement is "add a confirm button," not "add a key system."

### Read-only attach
- **What changes:** A new attach mode `--read-only` that suppresses input. Useful for shoulder-watching, code review demos, support sessions.
- **Why not now:** No demonstrated demand and adds a permission dimension (`terminal.attach.input` vs `terminal.attach.read`) that complicates the v1 grant model.
- **What today's code must not do:** Hardcode "attach implies input." The runtime should structure the attach record so that an `input_allowed` flag is a one-line addition.

### Plugin sandbox shell (Kind 2)
- **What changes:** A plugin can expose a `sh` inside its sandbox container as a registered terminal, useful for plugin debugging in production.
- **Why not now:** Requires container-exec plumbing in the runtime that does not exist yet, and a clearer story on grant scoping (sandbox shell is more sensitive than a Minecraft console).
- **What today's code must not do:** Assume `source: plugin` always means "stdin/stdout of an existing process." The source field is extensible — leave room for `source: plugin-sandbox` as a sibling without a schema change.

### Mobile attach
- **What changes:** Native xterm-equivalent in the iOS/Android app for attaching to terminals on the go.
- **Why not now:** Mobile apps are Phase 3+. The web panel works in mobile browsers in the meantime.
- **What today's code must not do:** Assume the attach client is always on a desktop-class device. Frame sizes, ping intervals, and reconnect semantics should not require a continuously-foregrounded process.

### Read-only audit-log streaming
- **What changes:** A new attach mode that streams only post-decryption metadata events (commands typed, exit codes) for compliance use cases. Requires the registrant to opt in (decryption happens on the host and metadata is re-encrypted to the auditor).
- **Why not now:** Pure infrastructure; nobody is asking yet.
- **What today's code must not do:** Build the relay assuming exactly two parties per session. The session/key model should already support N parties cleanly.
