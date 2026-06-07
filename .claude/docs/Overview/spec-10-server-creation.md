---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Every feature is a choice"
depends-on: [spec-03-server-container, spec-09-client-apps]
last-verified: 2026-04-05
---

# 10 — Server Creation Flow

*The desktop wizard that creates a server. Step by step, what happens at each stage, and what happens if it fails.*

---

## Prerequisites

Server creation is **desktop app only.** It requires:

1. The Electron desktop app installed and running.
2. Docker installed and the Docker daemon running.
3. A valid UnCorded account (logged in).
4. A paid hosting subscription (or a free tier if available — see `spec-14-monetization.md`).

If Docker is not detected, the wizard shows a prompt to install Docker with a link to Docker's installation page. The wizard does not proceed until Docker is confirmed running.

---

## The Wizard

```
Step 1: Server Identity
        [Field: server name]
        [Field: server description (optional)]

Step 2: Visibility
        (•) Private — invite only (default)
        ( ) Public — listed in the UnCorded directory

Step 3: Plugins
        Core plugins are pre-checked as sensible defaults.
        Uncheck anything you don't want.

        Core plugins (bundled with the base image):
          [x] text-channels
          [x] members
          [x] moderation
        Marketplace plugins (optional, unchecked by default):
          [ ] photo-gallery
          [ ] polls
          [ ] music-queue

        A server can still be created with zero plugins if every box
        is unchecked. Plugins can be added or removed at any time
        from the server settings or admin panel.

Step 4: Tunnel Mode
        (•) Production server (recommended)
            Requires a free Cloudflare account. Stable URL that
            survives restarts. Invite links persist.

        ( ) Demo server (temporary)
            No account needed. URL changes on every restart.
            Invites will break. For testing only.

            ⚠ Demo servers use trycloudflare.com which can experience
            outages. Do not use for servers you rely on.

Step 5: Review & Create
        Server name: My Family Server
        Visibility: Private
        Plugins: text-channels, members, moderation
        Tunnel: Production (Cloudflare authenticated)

        [Create Server]
```

---

## What Happens When the User Clicks "Create Server"

Each step is sequential. Progress is streamed to the UI. Any failure rolls back completed steps where possible.

```
[1] Register with Central
    → Desktop app calls POST /v1/servers { name, description, visibility }
    → Central creates the server record
    → Returns { server_id, server_secret }
    → On failure: show error, stop. Nothing to roll back.

[2] Pull base image
    → docker pull uncorded/server:<latest>
    → Progress bar shows download progress
    → On failure: show error ("Could not pull image — check internet connection"), stop.
      Central registration is rolled back (DELETE /v1/servers/:id).

[3] Prepare volumes
    → Create host directories: ~/.uncorded/servers/<slug>/{plugins,data,config}
    → On failure: show error, roll back Central registration.

[4] Install selected plugins
    → For each selected marketplace plugin: download from marketplace, verify signature,
      extract to <volume>/plugins/<slug>/
    → Core plugins are already in the image — just add their slugs to installed_plugins[]
    → On failure: show which plugin failed and why. Roll back Central registration.

[5] Write server config
    → Create <volume>/config/server.json with:
      server_id, server_secret, central_url, tunnel config, installed_plugins[]
    → If authenticated tunnel: write tunnel credentials to <volume>/config/tunnel.json
    → On failure: show error, roll back Central registration.

[6] Start container
    → docker run with:
      - Three volumes mounted (/plugins, /data, /config)
      - Port 3000 exposed
      - --cap-drop=ALL + necessary caps re-added
      - --security-opt=no-new-privileges
      - --read-only (root filesystem)
      - Restart policy: unless-stopped
    → On failure: show Docker error, roll back Central registration.

[7] Wait for readiness
    → Desktop app polls the container's /health endpoint
    → Timeout: 60 seconds
    → On timeout: show error ("Server started but didn't become healthy"), suggest checking
      container logs. Container is left running for debugging. Central registration is NOT
      rolled back (server exists, just unhealthy).

[8] Confirm tunnel URL
    → First heartbeat from the container delivers the tunnel URL to Central
    → Central updates the directory entry with the live URL
    → On failure: server is running but not discoverable. Show warning, suggest checking
      tunnel configuration.

[9] Success
    → Show "Server is live!" screen
    → Display: server name, tunnel URL, invite link (for private servers) or directory link
      (for public servers)
    → Offer: "Open server" button to connect immediately
```

---

## Rollback Strategy

The wizard is **transactional as far as possible.** If a late step fails, earlier steps are rolled back:

| Failure at step | What gets rolled back |
|---|---|
| 1 (Central registration) | Nothing — nothing was created yet |
| 2 (image pull) | Central registration deleted |
| 3 (volume creation) | Volumes cleaned up, Central registration deleted |
| 4 (plugin install) | Downloaded plugins removed, Central registration deleted |
| 5 (config write) | Config files removed, Central registration deleted |
| 6 (container start) | Container removed, Central registration deleted |
| 7 (health timeout) | Container left running for debugging. Central NOT rolled back. |
| 8 (tunnel confirm) | Server is running, just not discoverable. Warning shown. |

Steps 7 and 8 are not rolled back because the server is running and may just need time or a config fix. Destroying a running server because it was slow to start is worse than leaving it for the owner to investigate.

---

## After Creation

Once created, the server appears in the desktop app's server list with lifecycle controls:

- **Start / Stop** — start or stop the Docker container
- **Open** — connect to the server in the shell viewport
- **Settings** — open the admin panel (`/admin/` on the tunnel URL)
- **Logs** — stream container logs
- **Delete** — stop container, optionally deregister from Central, optionally delete data volumes. Requires explicit confirmation.

Plugins can be added or removed at any time via the admin panel or the desktop app's plugin management screen — the wizard is just the initial setup.

---

## Summary

| Question | Answer |
|---|---|
| Where does server creation happen? | Desktop app only (requires Docker) |
| How many wizard steps? | 5 (name, visibility, plugins, tunnel, review) |
| What's the default plugin selection? | Core plugins pre-checked. Marketplace plugins unchecked. Owner can uncheck everything. |
| What's the default tunnel mode? | Production (recommended). Demo available for testing. |
| Is the wizard transactional? | Yes — late failures roll back earlier steps where safe. |
| What if the server starts but isn't healthy? | Container is left running for debugging. Not auto-destroyed. |
| Can plugins be changed after creation? | Yes. Admin panel or desktop app. The wizard is just the first setup. |

---

## Future Refinements

### Web-based server creation (managed hosting)
- **What changes:** Users can create servers from the web app, without Docker or the desktop app. The container runs on UnCorded-managed infrastructure.
- **Why not now:** Managed hosting is post-launch. See `spec-03-server-container.md` and `spec-14-monetization.md`.
- **What today's code must not do:** The wizard's API calls to Central (`POST /v1/servers`) must not assume the caller is a desktop app running Docker locally. The API should accept a `hosting_mode: "self" | "managed"` field — even if Phase 1 only supports "self" — so the managed path can be added without API changes.

### Server templates
- **What changes:** Pre-configured server templates for common use cases: "Gaming Community" (text-channels + voice + moderation), "Family Space" (text-channels + photo-gallery), "Dev Team" (text-channels + kanban + code-review). Templates pre-select plugins and configure default roles.
- **Why not now:** Templates need real usage data to know which presets are useful. Guessing templates before Phase 1 is wasted effort.
- **What today's code must not do:** The wizard must accept a `template` parameter that pre-fills steps 2-4. Even if no templates exist in Phase 1, the mechanism must be present so templates can be added as a data change, not a code change.

### One-click Docker installation
- **What changes:** If Docker is not detected, the wizard offers to install it automatically instead of linking to Docker's website.
- **Why not now:** Docker installation is platform-specific and changes frequently. Automating it is fragile. Linking to Docker's official installer is safer for Phase 1.
- **What today's code must not do:** The Docker detection step must be a separate, testable function — not inline wizard logic. When auto-install ships, it replaces the detection function's "not found" path, not the wizard flow.

---

## Amendment A (2026-05-11 — applies in PR-TR2..TR5)

### Motivation: the tunnel-propagation race

Step 8 ("Confirm tunnel URL") above treats the first heartbeat as the readiness signal. In practice that signal fires while the public Cloudflare tunnel is still propagating across edge colos, so the wizard can hand the user off to a server whose hostname returns 521/522/523/404 for the first few seconds (or longer). The user sees "Failed to load sidebar — check your connection", clicks around to no effect, and only a hard refresh recovers — by which time the tunnel has propagated.

Two distinct facts make first-heartbeat a false ready signal:

1. The runtime's tunnel daemon emits "Registered tunnel connection" *before* its ingress config is installed and before all four CF edge connections are up. The first connection is registered with only the catch-all 404 ingress rule, and edge colos that have not yet seen the registration return 5xx for the hostname.
2. Heartbeats are *outbound* HTTPS from the runtime to Central. They do not traverse the *inbound* tunnel ingress path that user browsers must use. A successful heartbeat says nothing about whether `https://<server>.uncorded.app/anything` is reachable.

### New step 8.5: Verify public tunnel reachability

Inserted between step 8 (heartbeat confirmation) and step 9 (success):

```
[8.5] Verify public tunnel reachability
    → Desktop app probes the public tunnel URL's /ready endpoint via HTTPS,
      from the user's own network vantage. Budget: 60s. Poll interval: 1.5s.
    → A 200 response means the runtime is willing to serve authenticated
      traffic from at least the CF edge colo the user is currently routed to.
    → On success: emit wait-public-tunnel: completed and continue to step 9.
    → On 60s budget exhaustion: emit wait-public-tunnel: WARNING (not error).
      The wizard transitions to "still propagating" UX rather than rolling
      the server back. Server is alive. User is given a "Switch anyway" and
      a "Close and check later" option.
    → A background probe continues for up to 5 minutes after the budget is
      exhausted. If it succeeds while the wizard is still open, the dialog
      auto-completes the handoff.
```

### Layered defense (three vantages, different network paths)

| Layer | Where it runs | What it checks | Failure semantics |
|---|---|---|---|
| Runtime gate | inside the container | cloudflared registered ingress config AND ≥2 edge connections (or 5s grace after first) | Hard — the runtime won't log "tunnel ready" until this is true |
| Runtime self-probe | inside the container, egressing out | `GET /health` on the runtime's own public URL | Soft — logs `tunnel_state: degraded` on failure, never aborts startup. Distinct network path from the desktop probe; informational only |
| Desktop probe | user's machine | `GET /ready` on the runtime's public URL | Soft — emits warning, never destroys the server. Authoritative for wizard handoff |

The runtime gate exists so the runtime stops lying about its own readiness — but it does NOT guarantee global CF edge propagation. The desktop probe is the user-vantage authority. The self-probe is a diagnostic witness for fleet observability.

### Failure semantics (LOCKED)

Probe failures past step 7 are **always soft**:

- The container is NOT destroyed for failing a readiness probe.
- Central registration is NOT rolled back for failing a readiness probe.
- The wizard surfaces a warning and offers user-driven escape hatches; it never silently fails.
- A future contributor who tightens this into a hard failure (e.g. "if the probe fails, delete the container") is contradicting this amendment and must update the amendment first.

The motivating principle, already documented for steps 7 and 8: *destroying a running server because it was slow to start is worse than leaving it for the owner to investigate*. Step 8.5 extends that principle to user-vantage probes.

### Client resilience requirements

Concurrent with the wizard changes, the client SHOULD become tolerant of transient tunnel flakes (the same class of failure that will recur post-launch for unrelated reasons — tunnel restarts, CF edge issues, brief network blips):

- The sidebar's initial `GET /plugins` call SHOULD retry transient failures (5xx, 408, 429, network errors) with bounded backoff (≤4 attempts, cap ~3s per delay) before flipping to the "Failed to load sidebar" error state.
- The WebSocket layer SHOULD expose a `forceReconnect(serverId)` that cancels in-flight backoff and immediately reopens. Used by the wizard when its background probe goes green so the sidebar populates without waiting on exponential-reconnect schedules.

### Probe endpoint choice

User-vantage probes (desktop + wizard background) use `/ready`, not `/health`:

- `/health` returns 200 whenever the process is alive — not enough.
- `/ready` returns 503 when the runtime is draining or its public-key cache is stale, in which case the wizard would otherwise hand the user off to a server that immediately fails on the first authenticated request.

The runtime self-probe uses `/health`, because it is asking "is my own tunnel hairpin reachable?", not "am I ready to serve users?" — the latter is trivially yes by the time the self-probe runs.

### Rollback Strategy — updated row

The Rollback Strategy table above gains one row (slotted between steps 8 and 9):

| Failure at step | What gets rolled back |
|---|---|
| 8.5 (public tunnel probe budget exceeded) | Nothing. Server is running, tunnel may still propagate. Warning shown. NOT rolled back. |
