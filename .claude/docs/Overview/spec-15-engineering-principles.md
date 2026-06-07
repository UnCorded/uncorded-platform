---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "All tenets"
depends-on: [spec-01-vision-and-wedge]
last-verified: 2026-04-16
---

# 15 — Engineering Principles

*The non-negotiable rules for every line of code. These are not suggestions. They are the contract.*

---

## 1. Security Is Not Optional

Every auth flow is designed before it is implemented. Every token has a clear lifetime, scope, and revocation path. Every API endpoint has a documented authentication model.

### What this means in practice

- No endpoint ships without authorization checks. "It's only called by our own UI" is not a valid reason to skip auth.
- Every piece of data has a documented owner and a documented blast radius if it leaks.
- Secrets are never committed. They are loaded from environment variables, secret managers, or the OS keychain.
- Cryptographic code uses well-reviewed libraries, never hand-rolled primitives.
- Rate limiting ships on every endpoint from Phase 1. Server-side and Central-side. Not a polish task.
- Escalating IP bans on repeated auth failures. Not configurable to "off."

### The test

Before shipping any endpoint or flow, ask: "If an attacker sends 10,000 requests to this in one minute, what happens?" If the answer is "the server crashes" or "nothing stops them," it's not ready.

---

## 2. Tests For Everything

If it isn't tested, it isn't done. A passing CI run is evidence. "It works on my machine" is not.

### What this means in practice

- **Unit tests** for pure logic: runtime helpers, auth verification, manifest parsing, capability checks, migration runner.
- **Integration tests** for plugin loading, route mounting, heartbeat flow, token validation against a mock Central, cross-plugin reads, cascade propagation.
- **End-to-end tests** for the critical paths: sign up, log in, create server, join server, send a message, install a plugin, ban a user, hot-reload a plugin.
- If a bug is fixed, a regression test is added. If a bug escaped tests, the test suite is extended.
- Tests run on every commit. A failing test blocks the merge.

### The test

Before shipping any fix or feature, ask: "If someone breaks this next week, will a test catch it?" If no, write the test before the PR is mergeable.

---

## 3. Production Standards From Day One

This is a product, not a prototype. Every component is built to the standard it will need to sustain in production, from the first commit.

### What this means in practice

- No `any` in TypeScript. Ever. Not even in test utilities.
- Typed errors, not raw `Error` instances. Every error has a code, a message, and enough context to debug without a reproduction.
- Structured logging. JSON logs with timestamps, levels, plugin slugs, user IDs (not content), and request IDs. Not `console.log("something broke")`.
- Observability (metrics, traces) on Central from launch. Plugin memory usage, request latency, event bus throughput — emitted as structured metrics even if no dashboard consumes them yet.
- Error reporting on client apps. Crashes and unhandled rejections are captured and surfaced, not silently swallowed.
- Graceful degradation — a broken plugin does not take down a server. A broken server does not affect other servers. A broken Central does not destroy running servers.
- Documentation for every public API and every config file.
- A release pipeline with signing, versioning, and rollback.

### The test

Before shipping any component, ask: "If this runs for a year without anyone looking at it, will it produce enough information to debug a problem at 2am?" If no, add the logging and metrics before shipping.

---

## 4. Simplicity Over Cleverness

One mechanism for each concern. Not two. Not "the old way and the new way." Not "a simple path and a power-user path that does the same thing differently."

### What this means in practice

- One mechanism for cache invalidation (heartbeat with dirty flag). Not two.
- One sandbox boundary (the container + subprocess). Not five overlapping isolation layers.
- One plugin SDK. Not three "legacy" ones and a new one.
- One communication protocol for plugins (WebSocket). Not WebSocket for events and HTTP for CRUD.
- If a feature can be delivered by a plugin, it is delivered by a plugin, not baked into the runtime. (Exception: roles and permissions are runtime infrastructure because every plugin depends on them.)
- If a decision can be deferred without cost, it is deferred until real usage informs it.
- Three lines of similar code is better than a premature abstraction.

### The test

Before adding any mechanism, ask: "Does something else in the system already do this?" If yes, use that thing. If the existing mechanism needs extending, extend it. Do not add a parallel path.

---

## 5. User Data Is Sacred

Central never touches it. There is no exception. There is no "just for analytics." There is no "temporarily for debugging."

### What this means in practice

- Central never touches user messages, files, voice audio, or plugin data.
- Plugins own their data and are responsible for it.
- Server owners can export it, back it up, and delete it. The backup is copying three directories.
- There is no hidden telemetry on user content. Performance metrics are aggregate and content-free: "this server has 12 connected users" is fine. "User abc123 sent 47 messages today" is not.
- The runtime treats message payloads as opaque bytes. It routes them — it does not read them. This is structural preparation for end-to-end encryption, even though E2E is not Phase 1.

### The test

Before shipping any feature that touches user-generated content, ask: "Does Central ever see this data, even transiently?" If yes, redesign. If a future contributor asks "can we just send a sample to Central for debugging?", the answer is no.

---

## 6. Failures Are Loud By Default

Silent data loss is the worst failure mode. A silent drop with an observability event nobody is listening for is still silent. The default for any failure is to **surface it as a state transition the owning code must react to.**

### What this means in practice

- Default behavior on any queue-full, cache-miss, retry-exhausted, or resource-limit event is to **make it visible** — not emit a log line and keep going.
- The event bus default backpressure policy is `mark_unhealthy`, not `drop_oldest`. Plugins that want quiet drops opt in explicitly.
- Plugin loading produces per-step errors that name the plugin, the step, and the exact cause. Not "plugin failed to load."
- Cascade failures surface in the admin panel with retry buttons. Not silently half-completed.
- Rate limit rejections return specific error codes with `retry_after`. Not generic 500s.
- Quarantined plugins show a notice in the admin UI. Not silently not-running.

### The rule in one line

**If it can be silent, make it scream, and let the caller opt into silence with open eyes.**

### The test

Before shipping any failure path, ask: "If this fails at 2am and nobody is watching the logs, does anything change?" If the answer is "no, it just silently degrades," that's a Principle #6 violation. Make it loud. Make it visible. Make someone's code react to it.

---

## 7. Plugin Data Sovereignty

A plugin owns its SQLite database, its memory, and its CPU budget. The runtime does not police operations that live entirely inside the plugin's sandbox. Protection exists at boundaries — not inside them.

### What this means in practice

- **The runtime protects three boundaries only**: itself (IPC buffers, process memory), other plugins (cross-plugin reads), and clients (broadcast audience, WS frame size). A cap added inside a plugin's own data access — "add a LIMIT to this SELECT from the plugin's own table" — is not security. A plugin that wants to exhaust itself has a hundred easier paths than going through the IPC layer.
- **Caps belong at transport boundaries, not at query semantics.** `data.sql:self` has no row cap because the plugin owns the DB. `data.read` (cross-plugin) caps at 10,000 rows because it crosses a boundary. IPC lines cap at 4 MB because they are the transport. Broadcasts cap at 1 MB because they amplify across every recipient.
- **Inbound vs outbound asymmetry follows the same logic.** Inbound IPC is a stream parse — once the buffer exceeds cap without a newline, framing is lost and the only recoverable move is halt-and-kill the subprocess. Outbound IPC is discrete writes — each `send()` is a fully-framed line, so dropping one oversized message leaves the stream correctly framed. The asymmetry is not a quirk; it reflects where damage can and cannot be contained.
- **Plugin-facing errors are catchable; transport drops are the safety net.** When a cap fires at a boundary the plugin can observe (broadcast too large, response too large), the plugin receives a structured error it can handle. The transport's silent-drop safety net only fires if a handler missed — a layered failure with defined headroom between layers.
- **Audit findings that recommend capping inside the plugin sandbox are triaged as "by design."** "Plugin can read its own whole table" is not a gap. "Runtime can be OOM'd by a plugin writing 1 GB without a newline" is.

### The rule in one line

**The runtime caps its wire. A plugin owns its data.**

### The test

Before adding a cap, ask: "What boundary does this cross?" If none — if the limit is purely inside the plugin's sandbox — don't add it. If it's a transport or trust boundary, add it there, with a catchable error for the caller and a safety net one layer deeper.

---

## How Principles Interact

The principles are ordered by priority when they conflict:

1. **Security** — if a feature is insecure, it doesn't ship, no matter how simple, well-tested, or loud it is.
2. **Tests** — if it isn't tested, it doesn't ship, even if it's secure and simple.
3. **Production standards** — if it's not observable and debuggable, it doesn't ship.
4. **Simplicity** — if there's a simpler way, use it. But not at the cost of security, tests, or observability.
5. **User data** — never compromised. This is effectively tied with #1 but listed separately because it governs a different set of decisions (what data Central sees vs. how endpoints are protected).
6. **Loud failures** — the implementation principle that makes all the others work. A silent security failure is worse than a loud one. A silent test gap is worse than a loud one.
7. **Plugin data sovereignty** — a scoping rule for #1 and #4. It tells you *where* to apply security caps (at trust boundaries) and *where* simplicity forbids them (inside plugin-owned data). Prevents well-meaning defensive code from accumulating at the wrong layer.

In practice, conflicts between principles are rare. A secure, tested, observable, simple, privacy-respecting, loud-on-failure system that caps only at real boundaries is not a contradiction — it's just a well-built system.

---

## Enforcement

Principles that aren't enforced are wishes. Each principle has concrete enforcement mechanisms:

| Principle | Enforcement |
|---|---|
| Security | Auth checks on every endpoint. Rate limits on every endpoint. Capability checks on every IPC call. Code review requirement for any auth-adjacent change. |
| Tests | CI runs tests on every commit. Failing tests block merge. Coverage thresholds per module (exact numbers TBD after Phase 1 baseline). |
| Production standards | TypeScript strict mode with no `any`. Structured logging enforced by a shared logger that rejects unstructured calls. Linting via Oxlint. |
| Simplicity | Code review. "Does something else already do this?" is a required review question. |
| User data | Architectural constraint: Central has no API that accepts user content. This is enforced by the API surface design, not by vigilance. |
| Loud failures | Default backpressure is `mark_unhealthy`. Default error handling is typed error with context. Code review flags any `catch` block that swallows without re-throwing or surfacing. |
| Plugin data sovereignty | Code review flags any cap added inside a plugin's sandbox (e.g., `LIMIT` on `data.sql:self`, row caps on a plugin's own tables). Transport-layer caps (IPC line size, WS frame size, cross-plugin reads, broadcast audience) are explicit constants with dedicated tests. |
