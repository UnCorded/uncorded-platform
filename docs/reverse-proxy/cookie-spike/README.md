# Phase 0 cookie-topology spike — how to run

**Throwaway.** This harness is not production code and is not imported anywhere.
Its only job is to empirically confirm the proxy-session cookie attributes before
Phase 1 writes any bootstrap-cookie code. Fill the results into
[`../phase-0-cookie-topology-decision.md`](../phase-0-cookie-topology-decision.md)
and finalize the decision; that decision is the gate for Phase 1.

## What it models

The proxy-session cookie is set on, and only ever sent to, the **runtime**
origin. What varies is the **top-level shell** embedding the plugin iframe
(`uncorded.app`, `localhost:5174`, or Electron). Browsers evaluate the cookie
against that top-level site's third-party-cookie policy. Because the runtime
origin is variable and usually a *different site* from the shell
(`*.trycloudflare.com`, a custom Cloudflare hostname, or a temporary
`http://localhost:3000` fallback), the iframe is normally a **third-party
frame** and the cookie lives in a partitioned/third-party jar.

The harness sets a proxy-session-shaped cookie and reports whether it is carried
on the three browser-generated request types that the real proxy depends on:

1. **document navigation** into `/spike/embed` (iframe `src`)
2. **sub-resource `fetch()`** from the framed document
3. **WebSocket upgrade** to the runtime origin

## Cookie variants swept

| id | attributes | expectation |
|----|-----------|-------------|
| `lax` | `SameSite=Lax; Secure` | FAIL cross-site (not sent in 3p iframe subresource/WS) |
| `none` | `SameSite=None; Secure` | sent only if 3p cookies allowed; blocked under Chrome 3pc phase-out / Safari ITP / Firefox TCP |
| `none-partitioned` | `SameSite=None; Secure; Partitioned` | WORK cross-site (CHIPS) |
| `host-none-partitioned` | `__Host-` + `SameSite=None; Secure; Partitioned` | **predicted winner**; `__Host-` prefix viable |
| `dev-lax` | `SameSite=Lax` (no Secure) | http://localhost same-site dev fallback |

## Run

```bash
# 1. Start the spike server
bun docs/reverse-proxy/cookie-spike/spike-server.ts      # PORT=8787 by default

# 2a. Local baseline (same-site): open the shell directly
#     http://localhost:8787/spike/shell
#     Here shell origin == runtime origin == localhost  -> same-site baseline.

# 2b. Cross-site: expose the runtime on an HTTPS tunnel that matches production
cloudflared tunnel --url http://localhost:8787
#     -> prints a https://<random>.trycloudflare.com URL (the "runtime origin")
#     If you have an authenticated tunnel + custom hostname, use that too.
```

## Test each client path

For each shell, you embed the **runtime** iframe (`<tunnel>/spike/embed?v=<variant>`)
and read the three-row result table inside the iframe (also logged to the parent
console via `postMessage`).

### A. Web client (`localhost:5174`) and B. Desktop (Electron)

The runtime iframe must be embedded by the *actual shell origin* to get a real
third-party reading. Easiest: temporarily drop an iframe into the running shell
via DevTools console on the shell page (`http://localhost:5174`, or the Electron
window's DevTools):

```js
const TUNNEL = "https://<your-tunnel>.trycloudflare.com";  // the runtime origin
const f = document.createElement("iframe");
f.style = "position:fixed;inset:5%;width:90%;height:90%;z-index:99999;border:2px solid red;background:#fff";
f.src = TUNNEL + "/spike/embed?v=host-none-partitioned";
document.body.appendChild(f);
addEventListener("message", e => e.data?.kind === "spike-result" && console.log("[spike]", e.data.results));
```

Switch `v=` to each variant (`lax`, `none`, `none-partitioned`,
`host-none-partitioned`) and record YES/no for each of the three rows.
To test **navigation** carriage (vs first-load), append `&nav=1` and re-set
`f.src` a second time so the cookie already exists when the document loads.

### C. Live tunnel as top-level (sanity)

Open `https://<tunnel>/spike/shell` directly (shell == runtime == same-site) to
confirm the harness itself works end-to-end on HTTPS. This is the same-site
baseline, not the third-party case.

## Record per browser

Run the cross-site case (A/B) in at least **Chrome/Electron-Chromium**,
**Safari**, and **Firefox** — their third-party-cookie defaults differ. Note the
browser + version next to each result. Clear cookies between variants with
`<tunnel>/spike/reset` if needed.

## Teardown

`Ctrl-C` the spike server and the `cloudflared` process. Nothing persists; delete
the tunnel if it was throwaway. This entire `cookie-spike/` directory is
disposable once the decision record is locked.
