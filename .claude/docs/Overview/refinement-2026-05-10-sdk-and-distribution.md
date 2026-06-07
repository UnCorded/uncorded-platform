---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "The runtime exposes primitives, not patterns"
depends-on: [spec-04-plugin-architecture, spec-05-plugin-data-model, spec-11-marketplace, spec-15-engineering-principles]
last-verified: 2026-05-10
status: refinement — input to spec-04 and spec-11 revisions
---

# Refinement — SDK & Plugin Distribution (2026-05-10)

*Mental-model refinement of the plugin SDK and distribution path, produced from a working session on what UnCorded's plugin ecosystem needs to be. This document is the input to revisions of spec-04 (plugin architecture) and spec-11 (marketplace). It is not itself authoritative — it is the **why** behind the changes that go into those files.*

---

## Why This Document Exists

The original framing of "what unblocks third-party plugins" focused on six staged unlocks: sideload, npm publish, scaffolder, compat contract, extract core plugins, marketplace MVP. That framing is correct but incomplete — it describes the *plumbing* without stating the *posture* the plumbing has to serve.

This document fixes that. It captures the posture decisions that emerged from working through real plugin scenarios (a Minecraft server bridge, an Excalidraw collab board, OpenWebUI hosting, a dad's family photo dropbox), and it identifies the concrete refinements those decisions force into the existing specs.

---

## Posture: The Six Principles

### P1 — Primitives, not patterns

The runtime exposes a bounded catalog of primitives. Plugins compose them freely. UnCorded does not define plugin categories or sanctioned patterns ("photo plugin," "game integration," "collab editor"). The same primitive set has to serve a Minecraft server bridge, a Boards plugin, a family photo dropbox, and an OpenWebUI host — and the SDK has to make all of those feel native, not bolted on.

**Catalog (as of this refinement):** sidebar slot, panel surfaces (generic, browser; the *terminal* surface was removed in commit `95dec38`), entity storage with realtime+permissions, event bus, identity, file uploads, capability-gated host fs access, capability-gated network access, capability-gated process spawn, capability-gated container sidecar.

The catalog grows over time. It does not grow with patterns; it grows with primitives.

### P2 — Operator owns the trust boundary

On a server an operator runs themselves, plugins are allowed to do anything the operator authorizes — including direct host filesystem writes, process spawning, network access to arbitrary hosts. This is the *opposite* of the SaaS plugin model and it is the reason UnCorded can serve the bespoke-plugin case (the dad writing a photo dropbox for his family) that no other platform can.

The trust mechanism is **honest capability declaration in the manifest, surfaced verbatim to the operator at install time**. Capabilities are not bureaucracy; they are the literal contents of the install dialog. The operator reads "this plugin wants to write to `/home/dad/Pictures/family`, accept uploads from members of channel #family, and access `api.example.com`" — and decides.

### P3 — Two plugin lifecycles, one SDK

There are two distinct plugin lifecycles and the SDK must serve both with equal grace:

- **Bespoke plugins.** Written by the server operator (usually with Claude assistance), installed only on that operator's server, never published, never seen by anyone else. 80-line single-file plugins solving one operator's specific need. Example: dad's photo dropbox. These live in the sideload path.
- **Shared plugins.** Published to the marketplace, installed by other operators, maintained for an audience beyond the author. Example: an Excalidraw-Boards plugin used across many servers. These go through the publish pipeline and land in a trust tier.

The SDK must not optimize for one and crush the other. A 30-field manifest scares off the dad. A 5-field manifest collapses the contract under marketplace plugins. The grammar must scale: bespoke plugins fill in the minimum, shared plugins fill in the rest, the runtime treats both the same way once loaded.

### P4 — Three execution modes, one manifest

A plugin's *execution mode* is orthogonal to its *type* (core/standalone/extension). Three modes:

| Mode | What runs | Example |
|---|---|---|
| **module** | In-runtime subprocess spawned by the runtime (current model) | Photo dropbox, Boards, text-channels |
| **process** | Sidecar OS process spawned by the runtime under plugin's direction | Minecraft server (`java -jar paper.jar`) |
| **container** | Sidecar Docker container declared by the plugin and managed by the runtime | OpenWebUI, HedgeDoc, sidecar Postgres |

All three are expressible through the same manifest grammar, capability system, and supervision model. The SDK surface to a module plugin is the same as to the orchestrator of a container plugin — request/response, events, panels, identity. What changes is the `runs:` field in the manifest and the supervision strategy in the runtime.

Phase 1 ships **module** only. Process and container modes are reserved in the manifest grammar and roadmap as Phase 2.

### P5 — SDK quality bar is set by the LLM author

The expected author of plugins is an operator working with Claude (or another LLM) inside Claude Code or a future in-product plugin creator. That changes SDK design priorities in concrete ways:

- **Types are the contract**, not prose. Discriminated unions, branded types, narrow input shapes. No `any`, no escape hatches. LLMs follow types better than they follow docs.
- **Names are the documentation**. Every export, parameter, and error code is read by an LLM before it generates code. Clarity over cleverness; verbosity over magic.
- **Errors must teach**. "Invalid manifest" is a failure. "`manifest.permissions[2]` is `\"admin\"`; allowed values are `data.sql:self`, `data.read:<plugin>.<table>`, etc. See docs/permissions.md" is the bar.
- **Examples in JSDoc must run.** Every documented call site has a working example that compiles, executes, and produces the documented behavior.

This is not human-friendly SDK design as a side effect — it is *LLM-friendly SDK design as the primary target*. Humans benefit; LLMs require it.

### P6 — Two distribution channels

`@uncorded/plugin-sdk` and `@uncorded/plugin-sdk-frontend` are published to npm for **plugin authors at build time**. Operators never `npm install` plugins.

Plugins are distributed to operators as **signed tarballs delivered through the marketplace** (or sideloaded locally from disk). The runtime extracts, validates, and loads the tarball. This is the same mechanism for Official, Verified, Community, and sideloaded plugins — only the signature source and the install-dialog warnings differ.

Conflating these channels in the original "publish SDK to npm" framing led to the implicit assumption that plugin distribution = npm. It does not. npm is the build-time author channel only.

---

## What This Means for Spec-04 (Plugin Architecture)

The existing spec-04 is largely correct and well-aligned with these principles. The deltas to apply:

### D1 — Add `runs` field to manifest grammar (deferred enforcement)

The manifest must reserve a top-level `runs` field that declares execution mode. Phase 1 only accepts `runs: { mode: "module" }` (or the field's absence, defaulting to module). Process and container modes are rejected with `EXECUTION_MODE_NOT_SUPPORTED` in Phase 1.

```json
{
  "runs": { "mode": "module" }
}
```

Reserving the field now means Phase 2 can add `process` and `container` modes without a breaking manifest change. The runtime parses `runs`, validates it against the allowed-modes list for the current `api_version`, and rejects the rest.

### D2 — Tighten the principles section

Spec-04's opening currently describes plugins as "a folder containing backend code, frontend code, and a manifest." That's accurate but it doesn't state the posture. Add an explicit principles section at the top mirroring P1, P2, P3 — primitives not patterns, operator owns trust, bespoke and shared lifecycles share an SDK. These have to be the first things a reader of spec-04 internalizes.

### D3 — Make capability declaration its own first-class section

Capabilities are currently introduced under "Plugin Lifecycle → Permissions" and detailed under "Capability Permissions." They are not framed as the trust mechanism. Spec-04 should have a top-level section titled **Capability Declaration as Trust Mechanism** that states explicitly: capabilities are the literal contents shown to the operator at install time, the runtime enforces them at the IPC boundary, and the publish pipeline reviews them for plausibility. Move the permissions grammar table under that section.

### D4 — Note the LLM-author quality bar in SDK delivery

Spec-04's "Frontend Plugin SDK" section is well-specified but says nothing about *who is reading these types*. Add a short note: SDK type definitions, JSDoc, and error messages are designed for LLM authoring as the primary case. This binds future SDK changes — anyone proposing a breaking-or-clever change has to justify it against the LLM-reading bar.

### D5 — Standardize error-code surface

Spec-04 already mandates per-step actionable errors during plugin load. Extend this to every SDK call: every error thrown by the SDK or returned by the runtime over IPC carries a stable error code (string), a human-readable message, and a context object. Error codes are part of the api_version contract; renaming an error code is a breaking change.

This is the prerequisite for both LLM-authored recovery code and marketplace static analysis of plugin error-handling quality.

---

## What This Means for Spec-11 (Marketplace)

The existing spec-11 is closer to the model we landed on than I initially thought. The tier system (Official / Verified / Community / Unsigned-Sideloaded) is correct, automated review is correct, operator-approves-updates is correct, capability-diff at update time is correct. The deltas:

### D6 — Capability diff at install AND update

Spec-11 currently says updates show "new capabilities requested" in the changelog. Make this stronger and apply it symmetrically:

- **At install:** the install dialog displays the full capability set, grouped by category (data access, network, filesystem, process, etc.), each with a one-line explanation derived from the capability grammar. Operator approves the set or cancels.
- **At update:** if the new version requests any capability not present in the installed version, the install dialog re-appears with a **diff view** — green for added, red for removed, unchanged grayed out. Operator re-approves. If no capability changes, update is one click.

The capability text shown to operators is part of the spec, not the UI. Specify the wording for each capability so two install dialogs for the same capability set are byte-identical. This matters because operators learn to recognize legitimate capability requests by pattern, and inconsistent wording defeats that.

### D7 — Define the sideload path as a first-class lifecycle

Spec-11 mentions sideloading under the Unsigned tier in one row of a table. For the bespoke-plugin case to actually work, the sideload path needs its own section in spec-11 (or spec-04, but probably spec-11 since it's the install-side lifecycle):

- Where the operator drops plugin folders (`/data/plugins/` mounted, with a documented host path per platform: macOS, Linux, Windows).
- How the operator enables sideloading (`allow_unsigned_plugins: true` in server config, off by default).
- What the install dialog looks like for sideloaded plugins (full capability disclosure, no signature badge, clear "this plugin was installed from disk, not the marketplace" notice).
- The hot-reload behavior on sideload (file watcher picks up new directories, runs the same load pipeline as marketplace install).

This is the path the dad-with-Claude-Code case actually uses. It cannot be a footnote.

### D8 — `create-uncorded-plugin` is in scope but minimal

The original summary's "Stage 3 — create-uncorded-plugin starter" should ship, but as a *very thin* scaffolder that produces a working hello-world plugin against `@uncorded/plugin-sdk@<current>`. Its job is to be the LLM's starting context, not a tutorial. Output:

- `manifest.json` with required fields and inline comments explaining each
- `backend/index.ts` with one `sdk.handle` and one `sdk.events.publish`
- `frontend/index.html` with the SDK loaded and one `sdk.request` round trip
- `migrations/001_init.sql` empty stub
- `README.md` explaining only how to load the plugin into a server

That's it. No tutorial framework, no example library, no scaffold flags. The LLM does the rest.

This belongs in a roadmap item, not in spec-04 or spec-11 itself. Tracking it under spec-17 (phased build plan).

---

## What This Means for Spec-05 (Data Model)

The Boards / Excalidraw / HedgeDoc class of plugins all want the same primitive: **a typed entity with realtime + permissions + cross-plugin readable schema**. Spec-05 already provides the underlying mechanics (per-plugin SQLite, public_schema for cross-plugin reads, the event bus for realtime). The refinement is to make the *entity primitive* a first-class affordance in the SDK, not just a SQL+events combination plugin authors are expected to assemble themselves.

```ts
// Hypothetical SDK shape — not yet a contract
const boards = sdk.entity("board", {
  schema: { id: "string", name: "string", ownerId: "string", createdAt: "number" },
  permissions: { read: "member", write: "owner_or_admin" },
  realtime: true,
});

await boards.create({ name: "Sprint Planning", ownerId: user.id });
boards.on("created", (board) => { /* ... */ });
```

This is a wrapper over what's already specified — same SQLite, same events, same capabilities — but it surfaces the pattern explicitly so an LLM author writing a Boards plugin doesn't have to reinvent CRUD-plus-realtime from three lower-level primitives.

Whether this lands in spec-05 directly or in a new SDK-ergonomics doc is open. Flagging the need.

---

## Open Questions

These are unresolved after the working session and need decisions before the next round of spec revisions:

### O1 — Host filesystem capability beyond `storage.file:self`
The dad's photo dropbox needs to write to a host path like `/home/dad/Pictures/family`. The current capability grammar has `storage.file:self` (plugin's own data dir only). Options:

- (a) Add `fs.write:<path>` as a new capability, with `<path>` matched against an operator-approved allowlist at install time.
- (b) Keep `storage.file:self` only, and the operator manually bind-mounts the desired host path into the plugin's data dir at install time.
- (c) Defer: ship Phase 1 with `storage.file:self` only and revisit when the dad case actually has a user.

Lean: (a), because it makes the install dialog honest ("this plugin wants to write to `/home/dad/Pictures/family`"), but the path-allowlist UX needs design.

### O2 — Process spawn vs runtime-managed sidecar for Minecraft case
A Minecraft server plugin could spawn `java -jar paper.jar` from within its module backend (existing model — child process of the plugin subprocess) or declare `runs: { mode: "process", command: "java -jar paper.jar" }` and have the runtime manage it.

The first works today. The second is cleaner for supervision (restart policy, resource limits, capability isolation apply directly to the MC process), but requires building the process execution mode.

Lean: ship Phase 1 with plugin-managed child processes; reserve `runs: { mode: "process" }` for Phase 2 when supervision benefits are worth the runtime work. (The spec-25 terminal model referenced here was removed in commit `95dec38`; plugins still manage their own child processes, just without an interactive terminal surface.)

### O3 — Container sidecar mode (OpenWebUI case)
Whether `runs: { mode: "container" }` ships at all is a real decision. It enables OpenWebUI-class plugins (wrap an existing containerized self-hosted app), but it pulls Docker-in-Docker or Docker-socket-mount into the runtime, which is a large security surface.

Lean: defer to Phase 3 or later. The OpenWebUI use case is real but rare; Phase 1-2 plugin authors can sidestep with `process` mode + a manually-installed binary.

### O4 — Compat contract specifics for Community tier
Spec-04 already specifies semver, deprecation lifecycle (N supported through N+1, removable in N+2). What's missing is the *cadence*: how often does the api_version major bump? Is there a stated minimum support window in real time (e.g., "every api_version major is supported for at least 12 months after the next major ships")?

Without a calendar promise, community plugin authors have no basis for planning maintenance. With a calendar promise, UnCorded is on the hook for it.

Lean: commit to a minimum support window (12 or 18 months) at api_version 1.0 ship time. Phase 1 plugins are all first-party so this is hypothetical right now, but the promise has to exist before Community tier opens.

### O5 — `@uncorded/plugin-sdk` initial public version
The SDK is currently `0.0.1`, workspace-only. When it goes to npm:

- (a) Publish as `0.1.0`, flag as pre-1.0, breaking changes allowed during the Community-tier-opens period.
- (b) Publish as `1.0.0`, commit to semver from day one, accept that 1.x lives until 2027+.

Lean: (a). The SDK shape has not been used by anyone outside the core plugins. First Community authors will surface ergonomic problems we can't anticipate. Going to 1.0 before that feedback is paid for in pain later.

### O6 — `runtime.plugin.install` capability scope
Currently reserved for Official tier only (spec-04). When the in-product plugin creator surface ships, it will need this capability to install the plugins it generates. Either the creator itself is an Official plugin (clean) or the capability gets a separate "trusted internal caller" path (messier).

Lean: the in-product creator, when it ships, is implemented as an Official plugin. Keeps the capability gate honest. Defer this decision until the creator is being built.

---

## What Today's Code Must Not Do

The forward-compatibility constraints implied by this refinement:

- **Manifest parser must accept and round-trip the `runs` field** even though Phase 1 only honors `runs: { mode: "module" }`. Plugins shipping with `runs` declared will exist before Phase 2 supports them; the manifest grammar must not reject unknown values, only refuse to load plugins requesting unsupported modes.
- **Capability grammar must not collide with `fs.*`** namespace. Even if `fs.write:<path>` is deferred, the namespace must be left clear.
- **SDK error codes must already be stable strings**, not enum integers or formatted message text. Renaming codes later is a breaking change; locking the shape now is free.
- **Install dialog text must derive from a capability text registry** (one source of truth per capability), not be authored ad-hoc per UI surface. If both the desktop app and the admin panel render install dialogs, they must show identical wording for identical capabilities.
- **Sideload directory layout must be documented per platform from day one** even if the dad case is hypothetical at Phase 1 ship. Operators who find UnCorded in Phase 1 and try to write their own plugin will hit this immediately.

---

## Status

This refinement is **input** to revisions of:
- `spec-04-plugin-architecture.md` — apply D1 through D5
- `spec-11-marketplace.md` — apply D6 through D8
- `spec-05-plugin-data-model.md` — open question on entity-primitive SDK surface
- `spec-17-phased-build-plan.md` — add `create-uncorded-plugin` scaffolder, npm publish of SDKs, sideload-path completion as Phase 1.x items

Open questions O1 through O6 require decisions before those revisions land.
