---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Security is not optional"
depends-on: [spec-03-server-container, spec-06-authentication]
last-verified: 2026-04-05
---

# 07 — URL Security

*Why a public tunnel URL doesn't mean public access. How unauthenticated requests are rejected. How the tunnel failure → upgrade prompt works.*

---

## The Core Guarantee

Every server container has a public URL via its Cloudflare tunnel. That URL is accessible to anyone on the internet. This does not mean anyone can access the server.

**A public URL is a locked door with a public address.** Knowing where it is does not get you in.

Every request to the server — HTTP or WebSocket — is checked before any content is served:

| Request type | What happens without auth |
|---|---|
| `GET /` | Redirect to UnCorded login, or a minimal landing page with zero server data |
| `GET /ws` (WebSocket upgrade) | Upgrade accepted, but first message must be a valid auth token. Invalid token → connection closed immediately with error code. |
| `POST /upload` | 401 Unauthorized. No file is accepted. |
| `GET /plugins/<slug>/ui/*` | **Allowed unauthenticated** (by default). These are static code assets (JS, CSS, HTML) — the same for every user. No user data is exposed. Serving without auth enables browser caching and future CDN delivery. Plugins can opt into authenticated assets via `"authenticated_assets": true` in the manifest. |
| `GET /plugins/<slug>/manifest.json` | **Follows server visibility.** Public servers: unauthenticated. Private servers: 401. This prevents plugin enumeration on private servers — knowing which plugins are installed is metadata leakage. |
| `GET /admin/` | 401 Unauthorized. No admin panel rendered. |
| `GET /health` | Allowed unauthenticated — returns only `{ status, plugin_count, uptime }`. No user data, no server names, no content. |

**Unauthenticated endpoints:** `/health`, `/plugins/<slug>/ui/*` (code assets only), and `/plugins/<slug>/manifest.json` on public servers. None of these expose user data. The data boundary is the WebSocket and `/upload`, both of which are fully authenticated.

---

## Why This Matters

A family sharing photos on a homelab server does not want those photos accessible to anyone who discovers the tunnel URL. A Minecraft community doesn't want random users connecting without an account.

The tunnel URL being "public" is irrelevant because:

1. **No token = no data.** The server rejects every unauthenticated request except `/health`.
2. **Tokens come from Central.** A user must have a valid UnCorded account and must have been issued a server-scoped JWT by Central. Central checks: is the account valid? Is it banned? Only then does it issue a token.
3. **Private servers require an invite.** Even with a valid UnCorded account, joining a private server requires an invite code. The token alone is not sufficient — the server checks whether the user is in its member list.
4. **Public servers require an account.** A server listed in the public directory is discoverable, but joining still requires a valid UnCorded account. Public ≠ open-to-anonymous.

---

## What a Browser Sees Without Auth

If someone pastes a server's tunnel URL into a browser:

1. The browser sends `GET /`.
2. The server has two configurable responses:
   - **Redirect to UnCorded login** (default): sends the user to `https://uncorded.app/login?redirect=<server-url>`. After login, the app handles the connection with a proper token.
   - **Minimal landing page**: a static page that says "This is an UnCorded server. Download the app or log in to connect." No server name, no content, no member info.
3. The user cannot access any plugin UI, upload files, or open a WebSocket connection.

**No data leaks.** The server reveals nothing about itself to unauthenticated visitors beyond "I exist and I'm an UnCorded server."

---

## Plugin iframes and Auth

Plugin UIs render inside iframes in the UnCorded shell app. The shell passes the auth token via a `postMessage` handshake (see `spec-06-authentication.md`). The important security properties:

- **Tokens never appear in URLs.** No URL fragments, no query parameters, no referrer leaks.
- **Origin verification on both sides.** The shell verifies the iframe's origin before sending the token. The iframe verifies the shell's origin before trusting the message.
- **Each plugin iframe gets its own scoped token.** A malicious plugin iframe cannot read another plugin's token — they are in separate iframes with separate origins.
- **Shell pushes token refreshes.** The iframe never pulls. This means a compromised iframe cannot request tokens for plugins it doesn't own.

### What if someone copies a plugin iframe URL directly?

If a user copies `https://<tunnel-url>/plugins/text-channels/ui/` and pastes it in a browser:

1. The server receives `GET /plugins/text-channels/ui/index.html`.
2. The static assets (HTML, JS, CSS) **are served** — they're unauthenticated by default (they're code, not data).
3. The plugin UI loads in the browser but **has no auth token** — it was not delivered via the shell's postMessage handshake.
4. The plugin calls `sdk.request()` → fails. No authenticated WebSocket. No data returned. The UI renders empty or shows a "connect via UnCorded" prompt.
5. **The visitor sees the plugin's code and UI shell but zero user data.** The security boundary is the WebSocket, not the static assets.

For plugins that opt into `"authenticated_assets": true` in the manifest, static assets are also behind auth and the browser gets a 401.

---

## Tunnel Failure and the Upgrade Prompt

When a tunnel goes down, the server becomes unreachable. How this is handled depends on the tunnel mode:

### Demo tunnel (trycloudflare) failure

1. Runtime's `healthCheck()` detects the tunnel is unreachable.
2. Heartbeat reports `tunnel_state: "unreachable"` to Central.
3. Central marks the server as offline in the directory.
4. When a user tries to open this server in the shell app, instead of an error screen, the shell renders an **upgrade prompt** in the plugin viewport:

> "Demo servers use a temporary tunnel that can go offline. Ready for a production server? A free Cloudflare account gives you a stable URL that survives restarts."

5. The upgrade flow: user accepts → desktop app opens Cloudflare account setup → runtime config updated → tunnel restarted in Production mode → server back online with a stable URL.

**This turns an outage into a conversion moment.** The user learns about the better option at exactly the moment they need it.

### Production tunnel failure

1. Same detection: `healthCheck()` fails, heartbeat reports unreachable.
2. Central marks the server offline.
3. The shell shows a **connection error with diagnostics**: tunnel provider, last known URL, time since last successful health check, and a suggestion to check the Cloudflare dashboard.
4. No upgrade prompt — the user is already on the recommended tier. This is a real infrastructure issue that needs attention.

---

## Summary

| Question | Answer |
|---|---|
| Can someone access a server with just the URL? | No. Every endpoint except `/health` requires a valid auth token. |
| What does an unauthenticated visitor see? | A redirect to login, or a minimal "this is an UnCorded server" page. Zero content. |
| Can a plugin iframe URL be accessed directly? | No. Static assets are behind auth. 401 without a token. |
| Are tokens in URLs? | Never. postMessage handshake only. |
| What happens when the tunnel dies? | Demo → upgrade prompt (conversion). Production → error with diagnostics. |
| Can Central see what's behind the URL? | No. Central knows the URL exists. That's all it knows. |

---

## Future Refinements

### Custom landing pages
- **What changes:** Server owners can configure a custom unauthenticated landing page — server name, description, invite button, branding. Currently the landing page is generic.
- **Why not now:** Phase 1 servers are mostly private. Public servers with branded landing pages are a Phase 2+ concern when the directory is live and servers want to attract new members.
- **What today's code must not do:** The `/` route handler must be configurable, not hardcoded. A server config flag like `landing_page: "redirect" | "minimal" | "custom"` should exist in `server.json` even if only `redirect` and `minimal` are implemented.

### Per-plugin auth scoping
- **What changes:** A server owner could grant a user access to specific plugins but not others — e.g., a guest can see the photo gallery but not the text channels.
- **Why not now:** Phase 1 roles (owner/admin/mod/member) are server-wide. Per-plugin access control adds UI complexity and role management overhead that isn't needed for small Phase 1 communities.
- **What today's code must not do:** The auth token and role check must not assume "authenticated = access to all plugins." The permission check point where plugins are loaded into the iframe should be a function call that can be extended with per-plugin rules later, not an inline boolean.
