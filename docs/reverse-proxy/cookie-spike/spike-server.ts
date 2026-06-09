// THROWAWAY Phase 0 cookie-topology spike server. NOT production code.
// Do not import from this; do not ship it. It exists only to empirically
// validate proxy-session cookie attributes across the real client topologies
// before any bootstrap-cookie code is written (see
// ../phase-0-cookie-topology-decision.md and the plan's "Phase 0").
//
// Run:
//   bun docs/reverse-proxy/cookie-spike/spike-server.ts
// Then expose it on an HTTPS origin that matches a real runtime tunnel shape:
//   cloudflared tunnel --url http://localhost:8787      # *.trycloudflare.com
// and embed /spike/embed into each shell (see README.md).
//
// The spike models the real topology: the proxy-session cookie is set on, and
// only ever sent to, the *runtime* origin (this server). What varies is the
// TOP-LEVEL page embedding the iframe (the uncorded.app / localhost / Electron
// shell). The browser's third-party-cookie policy keys off that top-level site,
// so a cookie that is first-party to this server is nonetheless evaluated in a
// third-party partition when the shell origin differs.

const PORT = Number(process.env.PORT ?? 8787);

// Marker so we can tell *our* cookie apart from anything else on the jar.
const COOKIE_MARKER = "spike-ok";

// ---------------------------------------------------------------------------
// Cookie variant construction
// ---------------------------------------------------------------------------

interface Variant {
  id: string;
  label: string;
  samesite: "None" | "Lax" | "Strict";
  secure: boolean;
  partitioned: boolean;
  hostPrefix: boolean;
}

// The variants the spike sweeps. `host-none-partitioned` is the predicted
// winner for the cross-site production case; `lax` is the baseline expected to
// FAIL cross-site; `dev-lax` is the http://localhost same-site fallback.
const VARIANTS: Variant[] = [
  { id: "lax",                  label: "SameSite=Lax; Secure",                              samesite: "Lax",  secure: true,  partitioned: false, hostPrefix: false },
  { id: "none",                 label: "SameSite=None; Secure (unpartitioned)",             samesite: "None", secure: true,  partitioned: false, hostPrefix: false },
  { id: "none-partitioned",     label: "SameSite=None; Secure; Partitioned",                samesite: "None", secure: true,  partitioned: true,  hostPrefix: false },
  { id: "host-none-partitioned",label: "__Host-; SameSite=None; Secure; Partitioned",       samesite: "None", secure: true,  partitioned: true,  hostPrefix: true  },
  { id: "dev-lax",              label: "dev: SameSite=Lax (no Secure, localhost only)",      samesite: "Lax",  secure: false, partitioned: false, hostPrefix: false },
];

function variantById(id: string | null): Variant {
  return VARIANTS.find((v) => v.id === id) ?? VARIANTS[3]!; // default: predicted winner
}

function cookieName(v: Variant): string {
  return v.hostPrefix ? "__Host-uncorded-proxy-spike" : "uncorded-proxy-spike";
}

function setCookieHeader(v: Variant): string {
  // Mount-binding lives in the value in the real design (a __Host- cookie can't
  // be path-scoped); here the value is just the marker plus the variant id.
  const parts = [
    `${cookieName(v)}=${COOKIE_MARKER}.${v.id}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${v.samesite}`,
    "Max-Age=600",
  ];
  if (v.secure) parts.push("Secure");
  if (v.partitioned) parts.push("Partitioned");
  return parts.join("; ");
}

function clearCookieHeader(v: Variant): string {
  const parts = [`${cookieName(v)}=`, "Path=/", "Max-Age=0", `SameSite=${v.samesite}`];
  if (v.secure) parts.push("Secure");
  if (v.partitioned) parts.push("Partitioned");
  return parts.join("; ");
}

// Did THIS request carry our spike cookie?
function cookiePresent(req: Request, v: Variant): { present: boolean; raw: string } {
  const raw = req.headers.get("cookie") ?? "";
  const name = cookieName(v);
  const present = raw
    .split(/;\s*/)
    .some((c) => c.startsWith(`${name}=${COOKIE_MARKER}`));
  return { present, raw };
}

function clientOrigin(req: Request): string {
  // Best-effort: what origin issued this request (the iframe's own origin).
  return new URL(req.url).origin;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function shellHtml(frameBase: string): string {
  const optionTags = VARIANTS.map(
    (v) => `<option value="${v.id}">${esc(v.label)}</option>`,
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8"/>
<title>Proxy cookie spike — shell</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:0;background:#0f1419;color:#cdd6e0;padding:20px}
  h1{font-size:16px} code{background:#1b232c;padding:1px 5px;border-radius:4px}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}
  select,input,button{font:13px system-ui;padding:6px 8px;border-radius:6px;border:1px solid #2b3744;background:#161e26;color:#cdd6e0}
  button{cursor:pointer;background:#1f6feb;border-color:#1f6feb;color:#fff}
  iframe{width:100%;height:520px;border:1px solid #2b3744;border-radius:8px;background:#fff;margin-top:12px}
  .meta{font-size:12px;color:#7d8a99}
</style></head><body>
<h1>Proxy-session cookie topology spike — shell (top-level page)</h1>
<p class="meta">Top-level origin: <code>${esc(globalThis.location?.origin ?? "(this page's origin)")}</code> ·
Runtime/iframe origin: <code id="frameOrigin">${esc(frameBase)}</code></p>
<p>This page plays the role of the <b>shell</b> (uncorded.app / localhost / Electron).
The iframe below points at the <b>runtime</b> origin. If the two are different sites,
the iframe's cookies are third-party. Pick a variant and watch which requests carry the cookie.</p>
<div class="row">
  <label>Runtime base URL:
    <input id="base" size="42" value="${esc(frameBase)}"/>
  </label>
  <label>Variant: <select id="variant">${optionTags}</select></label>
  <button id="load">Load iframe</button>
  <button id="renav">Re-navigate iframe (tests nav carriage)</button>
</div>
<iframe id="f"></iframe>
<script>
  const f = document.getElementById('f');
  const base = document.getElementById('base');
  const variant = document.getElementById('variant');
  function src(){ return base.value.replace(/\\/$/,'') + '/spike/embed?v=' + encodeURIComponent(variant.value) + '&t=' + Date.now(); }
  document.getElementById('load').onclick = () => { f.src = src(); };
  document.getElementById('renav').onclick = () => { f.src = base.value.replace(/\\/$/,'') + '/spike/embed?v=' + encodeURIComponent(variant.value) + '&nav=1&t=' + Date.now(); };
  window.addEventListener('message', (e) => {
    if (e.data && e.data.kind === 'spike-result') {
      console.log('[spike] result from iframe:', e.data.results);
    }
  });
  f.src = src();
</script>
</body></html>`;
}

function embedHtml(v: Variant, docNav: { present: boolean; raw: string }, origin: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/>
<title>spike embed</title>
<style>
  body{font:13px/1.5 system-ui,sans-serif;margin:0;padding:14px;background:#fff;color:#111}
  h2{font-size:14px;margin:0 0 8px} table{border-collapse:collapse;width:100%;font-size:13px}
  td,th{border:1px solid #ddd;padding:6px 8px;text-align:left} .y{color:#0a7d28;font-weight:600} .n{color:#b00020;font-weight:600}
  code{background:#f2f3f5;padding:1px 4px;border-radius:4px;font-size:12px;word-break:break-all}
  .meta{color:#666;font-size:12px}
</style></head><body>
<h2>Runtime iframe — variant: <code>${esc(v.label)}</code></h2>
<p class="meta">Iframe origin: <code>${esc(origin)}</code> · cookie name: <code>${esc(cookieName(v))}</code></p>
<table>
  <thead><tr><th>Request type</th><th>Cookie carried?</th><th>Raw Cookie header</th></tr></thead>
  <tbody>
    <tr>
      <td>Document navigation into <code>/spike/embed</code></td>
      <td class="${docNav.present ? "y" : "n"}">${docNav.present ? "YES" : "no"}</td>
      <td><code>${esc(docNav.raw || "(none)")}</code></td>
    </tr>
    <tr><td>Sub-resource <code>fetch()</code></td><td id="fetchR">…</td><td id="fetchRaw">…</td></tr>
    <tr><td>WebSocket upgrade</td><td id="wsR">…</td><td id="wsRaw">…</td></tr>
  </tbody>
</table>
<p class="meta">Note: the cookie is <i>set</i> on this document response. If "Document navigation"
shows "no" on a fresh load that is expected (no cookie existed yet). Use the shell's
"Re-navigate iframe" button to test whether an already-set cookie is sent on navigation.</p>
<script>
  const variantId = ${JSON.stringify(v.id)};
  const results = { variant: variantId, docNav: ${JSON.stringify(docNav.present)} };
  function mark(id, present){ const el=document.getElementById(id); el.textContent = present?'YES':'no'; el.className = present?'y':'n'; }

  // (b) sub-resource fetch — same-origin to the runtime, evaluated under the
  // top-level site's third-party-cookie policy. The ?v= param is REQUIRED so
  // the server checks for THIS variant's cookie name (without it the server
  // falls back to the default variant and misreports every other variant).
  fetch('/spike/echo?v=' + encodeURIComponent(variantId), { credentials: 'include' })
    .then(r => r.json())
    .then(j => { mark('fetchR', j.present); document.getElementById('fetchRaw').innerHTML = '<code>'+(j.raw||'(none)')+'</code>'; results.fetch = j.present; post(); })
    .catch(e => { document.getElementById('fetchR').textContent = 'error: '+e; });

  // (c) WebSocket upgrade to the runtime origin. ?v= required for the same
  // reason as the fetch above.
  try {
    const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/spike/ws?v=' + encodeURIComponent(variantId);
    const ws = new WebSocket(wsUrl);
    ws.onmessage = (ev) => {
      try { const j = JSON.parse(ev.data); mark('wsR', j.present); document.getElementById('wsRaw').innerHTML='<code>'+(j.raw||'(none)')+'</code>'; results.ws = j.present; post(); ws.close(); } catch(e){}
    };
    ws.onerror = () => { document.getElementById('wsR').textContent = 'error'; };
  } catch (e) { document.getElementById('wsR').textContent = 'error: '+e; }

  function post(){ try { parent.postMessage({ kind:'spike-result', results }, '*'); } catch(e){} }
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Server (HTTP + WS)
// ---------------------------------------------------------------------------

interface WsData { v: Variant; cookieRaw: string; }

const server = Bun.serve<WsData>({
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);
    const v = variantById(url.searchParams.get("v"));

    if (url.pathname === "/spike/ws") {
      const { raw } = cookiePresent(req, v);
      const ok = srv.upgrade(req, { data: { v, cookieRaw: raw } });
      if (ok) return undefined;
      return new Response("ws upgrade failed", { status: 400 });
    }

    if (url.pathname === "/" || url.pathname === "/spike" || url.pathname === "/spike/shell") {
      const frameBase = url.searchParams.get("frame") ?? url.origin;
      return new Response(shellHtml(frameBase), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === "/spike/embed") {
      const docNav = cookiePresent(req, v);
      const headers = new Headers({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        // Allow this to be framed by any shell — the spike's whole point is
        // cross-site embedding. (Production proxy does NOT do this; iframe
        // policy belongs to the upstream app per the plan.)
        "Content-Security-Policy": "frame-ancestors *",
      });
      // Set the cookie on the document response (the partitioned-cookie path).
      headers.append("Set-Cookie", setCookieHeader(v));
      return new Response(embedHtml(v, docNav, clientOrigin(req)), { headers });
    }

    if (url.pathname === "/spike/echo") {
      const { present, raw } = cookiePresent(req, v);
      return Response.json({ present, raw, origin: clientOrigin(req) }, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/spike/reset") {
      const headers = new Headers({ "Content-Type": "text/plain" });
      for (const variant of VARIANTS) headers.append("Set-Cookie", clearCookieHeader(variant));
      return new Response("cleared", { headers });
    }

    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const present = ws.data.cookieRaw
        .split(/;\s*/)
        .some((c) => c.startsWith(`${cookieName(ws.data.v)}=${COOKIE_MARKER}`));
      ws.send(JSON.stringify({ present, raw: ws.data.cookieRaw }));
    },
    message() { /* spike is one-shot */ },
  },
});

console.log(`[spike] listening on http://localhost:${server.port}`);
console.log(`[spike] shell:  http://localhost:${server.port}/spike/shell`);
console.log(`[spike] embed:  http://localhost:${server.port}/spike/embed?v=host-none-partitioned`);
console.log(`[spike] expose with: cloudflared tunnel --url http://localhost:${server.port}`);
