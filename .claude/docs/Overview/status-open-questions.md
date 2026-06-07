---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "All tenets"
depends-on: [all files]
last-verified: 2026-04-14
---

# 18 — Open Questions

*Every `[TBD-*]` item in one place. Severity, context, what must happen before each resolves.*

---

## How to Read This File

- **HIGH PRIORITY** items must be resolved before the feature they gate can ship.
- **MEDIUM** items should be resolved during the phase they affect but are not hard blockers.
- **LOW** items are watch-it-not-solve-it — they become relevant when real usage data exists.
- Each item links to the file where it was first raised.

---

## HIGH PRIORITY

### [TBD-emergency-revocation-push]
**Gates: public server directory opening (Phase 2)**
Central currently propagates global bans via the 30-second heartbeat poll. For CSAM, credible threats, and account compromises, 30 seconds is too long. The fix is a push channel: Central opens a WebSocket to each running server and pushes emergency revocations in real-time. The polling heartbeat remains as a fallback.

This is architecturally straightforward — Central already has the server registry and tunnel URLs. The deferral is engineering time, not design complexity. The public directory does not open until this ships.

**Raised in:** `spec-13-trust-and-safety.md`, `spec-06-authentication.md`
**Resolves before:** Phase 2 public directory launch

---

## MEDIUM PRIORITY

### [TBD-pricing]
Exact server subscription tiers and scaling formulas. Depends on real cost data from Phase 1 servers. Known constraints: scales with connected users or MAU, generous defaults, no feature gating, transparency receipts eventually.

**Raised in:** `spec-14-monetization.md`
**Resolves before:** Phase 2 pricing goes live

### [TBD-central-shutdown-story]
What happens if Central permanently shuts down. Three options named: (A) accept the tension, (B) publish a signed "last will and testament" with fallback keys, (C) self-hostable Central. Not resolved — named honestly as an open question.

**Raised in:** `spec-08-uncorded-central.md`
**Resolves before:** no hard gate, but should be addressed before significant user base exists

### [TBD-minor-policy]
COPPA, age verification, minors policy beyond the starting position of "minimum age 13, server owners responsible for their own audience." Further policy work needed as real cases arise.

**Raised in:** `spec-13-trust-and-safety.md`
**Resolves before:** Phase 2 public directory (minors will find public servers)

### [TBD-central-secrets]
Which secret manager Central uses (Doppler, Vault, cloud-native KMS). Depends on Central's hosting environment.

**Raised in:** `spec-16-tech-stack.md`
**Resolves before:** Central deployment

### [TBD-plugin-install-capability]
When `runtime.plugin.install` actually ships. Capability is designed and reserved in Phase 1 (name, grammar, Official-tier-only restriction, per-call user confirmation, audit logging). Implementation is deferred until a concrete first consumer exists (likely Plugin Studio, post-launch).

**Watch item:** there is tension between deferring the tooling until real pain is known and pre-specifying the install mechanism before the first consumer exists. The current design is deliberately minimal. If the first real consumer needs a different grammar, treat the reservation as a placeholder, not a contract.

**Raised in:** `spec-04-plugin-architecture.md`, `Overview.md`
**Resolves before:** Plugin Studio ships (post-launch)

### [TBD-static-analysis-ruleset]
The concrete patterns the marketplace publishing pipeline's static analysis step checks for, their severities, and how the ruleset is maintained. Categories are defined; specific patterns are not.

**Raised in:** `spec-11-marketplace.md`
**Resolves before:** Community marketplace tier opens (Phase 2)

### [TBD-mobile-auth-model]
The postMessage iframe auth model does not port to native mobile. No iframe primitive on native; webview boundaries behave differently. When UnCorded targets mobile (Phase 3+), the auth delivery mechanism needs a parallel design.

**Raised in:** `spec-06-authentication.md`, `spec-09-client-apps.md`
**Resolves before:** Phase 3 mobile app

---

### [TBD-plugin-config]
**Gates: per-server plugin configuration (unscheduled)**
Server owners should be able to configure plugin behavior per-server — e.g. max message length in text-channels, whether file uploads are allowed, rate limits per plugin. This requires: (1) a `config` schema field in the plugin manifest, (2) a `plugin_config` table in core DB (owned by Core Module), (3) a `sdk.core.getConfig()` SDK method for plugins to read their configuration at runtime, (4) an admin UI for owners to set config values. None of these are built or specced beyond this note.

The design constraint is that plugin config must be validated against the manifest schema at write time — free-form JSON blobs are not acceptable because they create silent misconfiguration bugs.

**Raised in:** `spec-22-core-module.md`
**Resolves before:** any plugin ships configurable behavior (no current gate — deferred until a concrete plugin needs it)

---

## LOW PRIORITY (Watch Items)

### [TBD-sqlite-contention]
Per-plugin SQLite in WAL mode is fine for Phase 1 (5-20 plugins, small servers). Revisit if real-world usage shows contention, checkpoint stalls, or I/O ceilings under load. Not a pre-solve problem.

**Raised in:** `spec-05-plugin-data-model.md`
**Resolves when:** real data shows a problem, or it doesn't and this item is retired

### [TBD-resource-limit-defaults-tuning]
Default per-plugin memory (128 MB), CPU weight (1024), PID (32), FD (256), and disk quota (512 MB) are starting points. Need tuning against real plugin behavior.

**Raised in:** `spec-04-plugin-architecture.md`
**Resolves when:** Phase 1 servers are running real plugins with real usage

### [TBD-tunnel-provider-list-finalization]
Phase 1 is Cloudflare (locked). Phase 2 is Tailscale Funnel (committed). Beyond that: which of ngrok, self-hosted FRP, and direct port-forwarding ship, and in what order.

**Raised in:** `spec-03-server-container.md`
**Resolves when:** Phase 2 tunnel work begins

### [TBD-persist-overflow]
Event bus `persist` overflow policy — spill events to disk for replay. Reserved in the backpressure policy enum but not implemented. Adds disk quota interaction, durability guarantees, and replay ordering complexity.

**Raised in:** `spec-04-plugin-architecture.md`
**Resolves when:** a plugin with a concrete durability requirement exists

---

## Resolved (Closed)

These were open questions earlier in the design process and are now resolved. Listed here for traceability.

| Former TBD | Resolution | Where documented |
|---|---|---|
| `[TBD-iframe-auth]` | postMessage handshake, origin-verified both ways, no URL fragments | `spec-06-authentication.md` |
| `[TBD-web-token-storage]` | `__Host-` HTTP-only cookie, SameSite=Strict, Secure | `spec-06-authentication.md` |
| `[TBD-protocol]` | MessagePack for WS frames, JWT/JSON for tokens | `spec-16-tech-stack.md` |
| `[TBD-central-language]` | Bun, with 72-hour Node migration tripwire | `spec-16-tech-stack.md` |
| `[TBD-hot-reload]` | Ships in Phase 1 for DX reasons | `spec-04-plugin-architecture.md` |
| `[TBD-voice-turn-hosting]` | Self-host default with bundled TURN on TCP/443; managed relay deferred to Phase 2.5 under explicit consent | `spec-24-voice.md` |
