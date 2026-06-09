# Foundry VTT — Manual QA (real upstream)

The automated suite proves the proxy spine against a Foundry-*shaped* stub
(`runtime/src/http/foundry-proxy.test.ts`) so CI needs **no Foundry install and
no license**. This checklist covers what the stub deliberately cannot: a real
Foundry server, a real browser engine, and the third-party-cookie behavior that
only shows up in a live cross-site tunnel topology.

Run this once before shipping the plugin to operators, and again whenever the
proxy forwarder, the bootstrap-cookie attributes, or the Foundry frontend panel
change.

## Prerequisites

- A machine running **Foundry VTT** locally (the operator's own license — do
  not ship or commit any Foundry assets).
- An UnCorded server container reachable through its `tunnel_url` (a Cloudflare
  quick tunnel is fine), so the client shell and the runtime origin are
  genuinely cross-site — this is the topology the Phase 0 cookie decision was
  validated against.
- Owner/admin access to that server in the UnCorded client.

## Setup

1. Start Foundry on the host (default `http://localhost:30000`). From inside the
   server container it is reachable as `http://host.docker.internal:30000`,
   which is the plugin's default `foundry_upstream_url`.
2. Install the `foundry-vtt` plugin on the server.
3. Open the plugin's settings as an owner and set **Foundry upstream URL** to the
   address the *container* can reach (usually the `host.docker.internal` default;
   use the LAN IP if Foundry runs on another box).
4. **Approve the mount.** In the plugin settings → *Reverse-proxy mounts*, the
   `foundry` mount should read **Pending approval**. Click **Approve**.
   - Confirm saving the upstream URL alone did **not** flip it to approved —
     approval is always an explicit, separate action.
   - Expect a `host.docker.internal` / loopback / RFC1918 advisory warning; that
     is informational, not a block.

## Functional checks (Chromium/Firefox — iframe path)

Open the **Foundry** item in the sidebar (Tabletop section). The panel should
bootstrap a proxy session and load Foundry in the iframe. Verify:

- [ ] **Setup screen loads** — the Foundry setup/admin screen renders in the panel.
- [ ] **World login works** — launching a world and logging in as a user succeeds.
- [ ] **Static assets load** — no broken images/styles; CSS, fonts, JS, and the
      canvas tiles/tokens all load (check the network tab for 200s under
      `/proxy/foundry-vtt/foundry/...`).
- [ ] **Cookies persist under the mount** — after login, reloading the panel
      keeps you logged in (the Foundry session cookie was rewritten to
      `Path=/proxy/foundry-vtt/foundry` and replays correctly).
- [ ] **WebSocket / live session works** — open a scene, move a token, send a
      chat message; updates propagate in real time (Foundry's socket.io channel
      is carried through the proxy WS bridge).
- [ ] **Reload works** — a hard refresh of the panel and a deep link (e.g. a
      `/game` URL) both reload through the proxy without 404/redirect breakage.

## Fallback check (Safari/WebKit — locked Phase 0 decision §4a)

WebKit does **not** send the proxy-session cookie inside a cross-site iframe, so
the in-panel iframe is expected to fail to authenticate there. The plugin must
degrade gracefully:

- [ ] In Safari (or a WebKit-based client), opening the Foundry panel shows the
      **"Open in browser"** affordance (the iframe may be blank or show the
      can't-load message).
- [ ] **"Open in browser" opens the proxied URL** — it navigates top-level to
      `/proxy/foundry-vtt/foundry/` on the runtime origin (a **first-party**
      navigation, so the cookie carries), **not** to the private upstream URL
      (`host.docker.internal` / LAN IP). Confirm the address bar shows the
      proxied route and Foundry loads and stays logged in there.
- [ ] (Optional, future) If `requestStorageAccess()` support is added, verify the
      in-iframe path can be unlocked on WebKit; until then "Open in browser" is
      the supported path.

## What "done" looks like

All Chromium/Firefox functional checks pass in the iframe, and on WebKit the
"Open in browser" fallback reaches the proxied route (never the raw upstream)
and is fully functional. File any deviation against the proxy forwarder or the
Phase 0 cookie decision record — the plugin frontend itself is intentionally
thin and should rarely be the cause.
