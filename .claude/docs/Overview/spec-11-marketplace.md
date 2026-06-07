---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Security is not optional"
depends-on: [spec-04-plugin-architecture, spec-08-uncorded-central]
last-verified: 2026-04-05
---

# 11 — Plugin Marketplace

*How plugins are published, distributed, discovered, trusted, and revoked.*

---

## What the Marketplace Is

The marketplace is a **section of UnCorded Central** where developers publish plugins and server owners browse and install them. It distributes executable code — so trust is the central design concern.

---

## Trust Tiers

Every plugin has a trust tier. The tier determines how it was reviewed, how it is presented in the UI, and what level of trust the user should place in it.

| Tier | Who publishes | Review process | Badge | Phase |
|---|---|---|---|---|
| **Official** | UnCorded | Built and maintained by UnCorded. Signed with UnCorded's release key. | Official badge | Phase 1 |
| **Verified** | Identity-verified publishers | Publisher completed identity verification + security review. Signs releases with a publisher key UnCorded has on file. | Verified badge | Phase 2 |
| **Community** | Any UnCorded account | No review. Signed with a self-generated publisher key. Displayed with a clear "community plugin" label. | Community label | Phase 2 |
| **Unsigned / Sideloaded** | Manual file drop | Server owner dropped a folder into `/plugins/` manually. Runtime loads it only if `allow_unsigned_plugins: true` in server config (off by default). | No badge (not in marketplace) | Phase 1 (local only) |

**Phase 1 ships Official tier only.** The marketplace contains only UnCorded's own plugins (text-channels, members, moderation, and any additional first-party plugins). Verified and Community tiers open in Phase 2.

---

## Publishing Pipeline

When a developer uploads a plugin to the marketplace, it goes through an automated pipeline before it becomes available for download:

```
[1] Manifest validation
    → Is manifest.json present and schema-valid?
    → Are all required fields populated?
    → Is the api_version range compatible with at least one current runtime version?

[2] Dependency resolution
    → Are all declared dependencies available in the marketplace?
    → Are version ranges satisfiable?

[3] Signature verification
    → Is the package signed with a key the marketplace recognizes?
    → Official: UnCorded's release key
    → Verified: publisher's registered key
    → Community: any valid key (self-generated)

[4] Static analysis
    → Scan for known-bad patterns:
      - eval(), Function(), dynamic imports from network
      - Direct filesystem access outside PLUGIN_DATA_DIR
      - Network calls not mediated by http.fetch capability
      - Suspicious capability requests (e.g., a photo gallery requesting runtime.plugin.install)
    → Severities: block (hard reject), warn (flag for manual review), info (noted in report)

[5] Size limits
    → Package size under 50 MB (configurable)
    → No single file over 10 MB (prevents embedded binaries)

[6] License check
    → License field in manifest must be a valid SPDX identifier
    → Warn if no license specified (not a hard block)

[7] Available for download
    → Package stored in Central's object storage (R2)
    → Metadata indexed in marketplace database
    → Visible in marketplace UI
```

### What the pipeline does NOT do

- It does not run the plugin code. Static analysis only.
- It does not verify that the plugin "works" — only that it is structurally valid and doesn't contain known-bad patterns.
- It does not replace manual review for Verified tier — the automated pipeline is a first pass, not the only gate.

---

## Discovery

Server owners browse the marketplace from the desktop app or the web app:

- **Search** by name, description, keyword
- **Filter** by trust tier, category, compatibility with their runtime version
- **Sort** by install count, rating, recently updated
- **Plugin detail page** shows: description, screenshots, trust tier badge, install count, active-server count, average rating, publisher info, capability requirements, resource requirements, version history

### Reputation signals

| Signal | What it tells you |
|---|---|
| Install count | How many servers have downloaded this plugin |
| Active-server count | How many servers are currently running this plugin (reported via heartbeat metadata) |
| Average rating | User satisfaction (1-5 stars) |
| Publisher history | Other plugins by this publisher, their ratings and track record |
| Recent security reports | Whether this plugin has been reported and the outcome |

---

## Installation Flow

1. Server owner finds a plugin in the marketplace.
2. Clicks "Install on [server name]."
3. Desktop app downloads the package from Central, verifies the signature.
4. Package is extracted to the server's `/plugins/<slug>/` directory.
5. Plugin slug is added to `installed_plugins[]` in `server.json`.
6. If the server is running: hot reload detects the new plugin and loads it.
7. If the server is stopped: the plugin loads on next start.

### Installation from the admin panel (web)

If the server owner is accessing the admin panel remotely (not from the desktop app):

1. Admin panel shows the marketplace browser.
2. Owner selects a plugin.
3. Admin panel calls the server runtime: "install plugin X from marketplace."
4. The runtime downloads, verifies, extracts, and loads the plugin.
5. This requires the `runtime.plugin.install` capability — currently reserved for Official-tier plugins only. When the admin panel itself uses this flow, it acts as a trusted internal caller, not a third-party plugin.

---

## Updates

Plugin updates follow the same pipeline as initial publication:

1. Developer publishes a new version to the marketplace.
2. Server containers discover updates on their next heartbeat (Central includes a `plugin_updates_available` flag if any installed plugin has a new version).
3. The admin panel or desktop app shows an "Updates available" notification.
4. Server owner reviews the update (changelog, new capabilities requested, new resource requirements).
5. Owner clicks "Update" → download, verify, extract (overwriting old version), hot reload.

**Updates are never automatic.** The server owner always reviews and approves. A plugin update could change behavior, request new capabilities, or break extensions — the owner must consent.

---

## Revocation

UnCorded can revoke a plugin version if it is found to be malicious, compromised, or in violation of the marketplace policy.

### How revocation works

1. UnCorded marks a specific plugin version as revoked in Central's database.
2. The revocation is pushed to servers via the heartbeat invalidation mechanism:

```json
{
  "dirty": true,
  "sync_version": 50,
  "deltas": [
    { "type": "plugin.revoked", "slug": "bad-plugin", "version": "1.0.3", "reason": "Malicious code detected" }
  ]
}
```

3. On receiving the revocation, the server runtime:
   - Stops the revoked plugin's subprocess.
   - Marks the plugin as quarantined in the admin panel.
   - Logs the revocation to the audit log.
   - Does NOT delete the plugin's data (the owner may need to inspect it).
4. The server owner sees a clear notice: "Plugin 'bad-plugin' v1.0.3 has been revoked by UnCorded: Malicious code detected. The plugin has been stopped."

### Revocation scope

- Revocations target a **specific version**, not the entire plugin. If v1.0.3 is bad but v1.0.2 was fine, only v1.0.3 is revoked. The owner can downgrade.
- If the publisher is compromised, all versions can be revoked and the publisher account suspended.

---

## User Reports

Any UnCorded account can report a plugin:

1. Click "Report" on the plugin's marketplace page.
2. Select a reason: malicious code, misleading description, broken functionality, inappropriate content, other.
3. Provide optional evidence (description, screenshots).
4. Report is submitted to Central's review queue.

Reports are reviewed by UnCorded. Verified publishers get priority response SLAs. Community plugins with multiple reports are automatically flagged for urgent review.

---

## Summary

| Question | Answer |
|---|---|
| What trust tiers exist? | Official, Verified, Community, Unsigned/Sideloaded |
| What ships in Phase 1? | Official tier only (UnCorded's own plugins) |
| Is there automated review? | Yes — manifest validation, dependency check, signature verification, static analysis, size limits |
| Are updates automatic? | No. Owner must review and approve every update. |
| Can plugins be revoked? | Yes. Per-version revocation via heartbeat. Server quarantines the plugin immediately. |
| Can users report plugins? | Yes. Reports go to Central's review queue. |
| Where are plugin packages stored? | Central's object storage (Cloudflare R2) |
| How are plugins installed? | Desktop app or admin panel downloads, verifies signature, extracts to /plugins/, hot reloads. |

---

## Future Refinements

### Paid plugins
- **What changes:** Developers can charge for plugins. The marketplace handles payment via Stripe Connect. UnCorded takes a percentage.
- **Why not now:** The plugin ecosystem doesn't exist yet. Adding a payment layer before there are plugins to sell is premature. Free plugins first, paid plugins when there's demand.
- **What today's code must not do:** The plugin metadata schema must include a `price` field (default: `null` for free). The marketplace UI must render plugin cards with room for a price badge. Even if every plugin is free in Phase 1, the data model supports paid plugins.

### Plugin analytics for developers
- **What changes:** Developers see install trends, active-server counts over time, ratings breakdown, and crash reports from servers running their plugin.
- **Why not now:** Requires opt-in telemetry from server containers and a dashboard UI. Phase 1 plugins are all first-party.
- **What today's code must not do:** The heartbeat payload includes `plugin_count` already. When analytics ships, extending the heartbeat to include installed plugin slugs (not data, just slugs) is a non-breaking change. The heartbeat schema should reserve room for a `plugins` field.

### Static analysis ruleset (`[TBD-static-analysis-ruleset]`)
- **What changes:** The concrete patterns the static analysis step checks for, their severities, and how the ruleset is maintained and updated.
- **Why not now:** The Community tier isn't open yet. The ruleset is only load-bearing when untrusted code enters the pipeline.
- **What today's code must not do:** The static analysis step must be a pluggable function, not inline code. When the ruleset ships, updating it should be a data/config change, not a code deployment.
