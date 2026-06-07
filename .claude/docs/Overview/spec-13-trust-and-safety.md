---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Security is not optional"
depends-on: [spec-02-system-overview, spec-06-authentication, spec-08-uncorded-central]
last-verified: 2026-04-05
---

# 13 — Trust, Safety, and Platform Responsibility

*What UnCorded acknowledges about platform responsibility, what it can do, what it will not build, and how it handles the hardest cases.*

---

## The Starting Position

UnCorded's architecture makes a deliberate choice: the platform never sees user content. Messages, files, voice, and plugin data live only on server owners' hardware. This is a privacy feature and a design constraint. It is also a legal and ethical question, and this document addresses it honestly rather than hiding behind the privacy story.

---

## What UnCorded Acknowledges

- Operating a directory of public servers and an identity system for private servers is **platform responsibility**, even when the platform does not host content.
- Server owners are legally responsible for what happens inside their servers. Self-hosting does not create a liability shield for anyone — not for them, and not for UnCorded.
- CSAM, terrorism content, coordinated harassment, and other clearly illegal material are real problems on every platform. Pretending otherwise is not an option.

---

## What UnCorded Can Do, and Will Do

### Accept reports against public servers
Public servers listed in the directory can be reported by any UnCorded account. Reports are reviewed against a published, versioned policy.

### Delist servers from the directory
A confirmed violation on a public server results in delisting. The server continues to exist on the owner's hardware, but it loses discoverability and — if the violation warrants it — the owner's UnCorded account is terminated, which cuts the server off from new auth validations and forces it offline to new users.

### Revoke accounts tied to clearly illegal activity
Without a valid UnCorded account, a server cannot receive auth validations or heartbeat responses. The runtime refuses new connections within one heartbeat cycle (30 seconds).

### Push emergency revocations via the heartbeat channel
The same mechanism that invalidates banned users propagates account and server revocations to every running server container within 30 seconds of the decision.

### Cooperate with lawful requests, within the limits of what we actually possess
We can provide: account email, account creation date, registered server URLs, directory metadata, billing records tied to paid hosting. We **cannot** provide: messages, files, voice recordings, member rosters, or any plugin data, because none of those ever touch our infrastructure. A subpoena for content gets an honest answer: we do not have it, and we cannot get it.

---

## What UnCorded Will Not Do

### Build content-scanning or backdoor capabilities into the runtime
The runtime will never include a mechanism to exfiltrate plugin data to UnCorded Central. Not for CSAM scanning, not for law enforcement, not for brand safety, not for any reason. Adding that capability — even with good intentions — would break the core guarantee that makes the platform viable for every legitimate use case. **This is a hard line.**

### Moderate content on private servers proactively
Private servers are not listed, not reported, and not visible to Central. The platform cannot moderate what it cannot see, and will not instrument itself to see.

### Pretend trust and safety is a solved problem
Policy will be published, public, versioned, and updated as real cases arise. This document captures the starting position, not the final word.

---

## The 30-Second Global Ban Window

When a user is globally banned by Central for a ToS violation — including CSAM or credible threats — the ban propagates to every running server on the next heartbeat, which can be up to **30 seconds** away.

During that window, the banned user remains connected and active on every server they are currently in. Local bans (issued by a server owner on their own server) are instant because they happen inside the server container. Global bans are not, under the current design.

**A 30-second window for a CSAM poster is not acceptable as a permanent state.**

The mitigation is an **emergency push channel** from Central to running servers — a WebSocket push that delivers emergency revocations in real-time, out-of-band from the polling heartbeat. See `[TBD-emergency-revocation-push]` in `status-open-questions.md`.

**This is HIGH PRIORITY for Phase 2 and gates the opening of the public server directory.** Phase 1 private servers with known user bases tolerate the 30-second window. The public directory does not open until the push channel ships.

---

## Anti-Abuse and Account Integrity

Banning by UnCorded account ID is stronger than banning by local account or IP — the ban propagates to every server the user is in. But it is **a deterrent, not a wall**, unless registration is gated.

A banned user can create a new account and try again. This is honest and the document does not imply stronger guarantees than the model delivers.

### Phase 1 baseline mitigations

- **Email verification required** on every registration.
- **Per-IP rate limit:** 3 registrations per IP per hour.
- **Per-ASN rate limit:** 20 registrations per ASN per hour.
- **CAPTCHA** on every registration.
- **Optional invite-only mode** during early Phase 1 — Central can require an invite code to register.

### Optional stronger identity signals (per-server policy)

- **Phone/SMS verification** — a server owner can require that joining users have a phone-verified UnCorded account. Off by default. Not required of the homelab audience. Available for servers that need stronger identity later.
- Phone verification happens at Central. The server sees only a boolean `phone_verified` flag on the user identity.

### What this does not solve

Determined adversaries with disposable phone numbers and residential proxies will still get through. Anti-abuse is a continuous game. This document captures the starting position.

---

## Minors, COPPA, and Age Verification

The Phase 1 wedge explicitly includes families — a dad sharing photos with his kids. Children are in that scenario.

### Starting position

- **Minimum age to register an UnCorded account: 13.** Registration requires affirming "I am 13 or older." This is the standard COPPA threshold used by every major platform.
- **Central does not knowingly collect personal information from users under 13.** If Central becomes aware that a user is under 13 (through a report or a support request), the account is suspended and the user's data is deleted from Central.
- **Server owners are responsible for their own audience.** If a server owner invites their 10-year-old to a family photo server, that is the owner's decision and responsibility. Central does not monitor who joins which server, because Central cannot see inside servers.
- **Central collects minimal data regardless of age.** Email, hashed password, display name, avatar. No birthday, no real name, no location, no activity tracking. This minimizes COPPA exposure.

### What this does not solve

Age verification on the internet is an unsolved problem industry-wide. A 12-year-old checking "I am 13 or older" is not stopped by any technical mechanism. The mitigation is: Central collects as little data as possible, and the data that matters (messages, photos, files) lives on the server owner's hardware, not on Central.

**Tagged: `[TBD-minor-policy]`** — further policy work is needed as the platform grows and real cases arise.

---

## The Operating Principle

Server owners are responsible for what happens inside their servers. UnCorded is responsible for who it lets into the directory, who it verifies with an account, and how quickly it can act when a report is credible.

Both responsibilities are real. Neither substitutes for the other.

A reader of this document who believes the privacy story exempts the platform from all downstream responsibility is reading it wrong. A reader who believes privacy should be compromised to make moderation easier is reading it wrong in the other direction.

---

## Summary

| Question | Answer |
|---|---|
| Does UnCorded moderate content? | No. Central never sees content. Server owners moderate their own servers. |
| Can UnCorded respond to reports? | Yes. Public servers can be reported. Confirmed violations → delisting + account revocation. |
| What can UnCorded provide to law enforcement? | Account email, registration date, server URLs, billing records. Not messages, files, or any user content. |
| Will UnCorded build content-scanning? | No. Hard line. It would break the core guarantee. |
| How fast are global bans? | Up to 30 seconds (heartbeat cycle). Emergency push channel is HIGH PRIORITY for Phase 2. |
| What about CSAM? | Reports → account revocation + server delisting within 30 seconds. Emergency push will make it near-instant. Law enforcement cooperation within the limits of what we possess. |
| Minimum age? | 13. Standard COPPA threshold. Central does not knowingly collect from under-13s. |
| Can ban evasion be stopped? | Deterred (email verification, CAPTCHA, rate limits, optional phone verification). Not perfectly prevented. Honest about this. |

---

## Future Refinements

### Emergency revocation push channel
- **What changes:** Central pushes CSAM/threat/compromise revocations to servers in real-time via WebSocket, bypassing the 30-second heartbeat poll.
- **Why not now:** Phase 1 private servers with known users tolerate the window. The push channel ships before the public directory opens.
- **What today's code must not do:** The server's Central connection handler must support both polling (heartbeat) and push (future WebSocket). The architecture must not make real-time push impossible. **This gates the public directory.**

### Published, versioned Trust & Safety policy
- **What changes:** A public document describing the reporting process, review criteria, appeal process, and enforcement actions. Versioned so changes are trackable.
- **Why not now:** Policy should be written from real cases, not hypotheticals. Phase 1 is small enough that cases can be handled directly.
- **What today's code must not do:** The reporting and review pipeline must support structured metadata (report type, evidence URLs, reviewer notes, decision, timestamp) from day one — even if the review process is manual in Phase 1. This data feeds the published policy later.

### Transparency reports
- **What changes:** Periodic public reports: how many servers delisted, how many accounts revoked, how many law enforcement requests received and what was provided.
- **Why not now:** Requires enough volume to be meaningful. A transparency report with "0 requests received" is honest but not useful.
- **What today's code must not do:** Every enforcement action (delisting, revocation, law enforcement response) must be logged in a structured, queryable format in Central's database. The transparency report is a query over this log.
