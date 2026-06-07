---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Collaborative-first"
depends-on: [spec-01-vision-and-wedge, spec-08-uncorded-central]
last-verified: 2026-04-05
---

# 14 — Monetization

*How UnCorded makes money. What's free, what's paid, and why the cost structure is intentionally low.*

---

## The Model

**Free accounts, paid hosting.** That's the entire model.

| What | Cost | Why |
|---|---|---|
| Creating an UnCorded account | Free | Accounts are how users join servers. Charging for accounts kills adoption. |
| Joining servers | Free | Users should be able to join any server without a paywall. The value is in the community, not the ticket to enter. |
| Hosting a server | Paid | Server owners register in Central's directory, validate users against Central's auth, download plugins from the marketplace, and receive heartbeat service. That infrastructure costs money to operate. |

---

## Why Server Hosting Is Paid

UnCorded Central provides four things to every server:

1. **Identity verification** — every user who connects to a server is verified by Central. Central issues tokens, maintains the public key infrastructure, and processes heartbeats.
2. **Server directory listing** — public servers are discoverable in the directory. Private servers use Central for invite link resolution.
3. **Plugin marketplace access** — server owners browse, download, and receive updates for plugins.
4. **Heartbeat and invalidation service** — every 30 seconds, every running server phones home. Central processes these, tracks online/offline status, and pushes invalidation deltas.

None of this involves user content, but all of it involves infrastructure. Servers, databases, bandwidth, on-call. That's what hosting fees pay for.

---

## Why Costs Are Low

UnCorded's infrastructure cost per server is **dramatically lower** than a traditional chat platform because:

- **Central never proxies user data.** Messages, files, voice — all handled by the server container on the owner's hardware. Central's bandwidth is limited to auth tokens, heartbeats, and marketplace metadata.
- **Heartbeats are tiny.** With the dirty flag optimization, 99% of heartbeats are a ~20-byte response. A thousand servers heartbeating every 30 seconds is negligible traffic.
- **No media storage.** Central does not store user-uploaded files, avatars beyond account profiles, or voice recordings. All of that is on the server owner's disk.
- **No message history.** Central has no database of messages to scale, backup, or index.

The infrastructure to run Central is roughly: a database (PostgreSQL), an API server (Bun), an object store for account avatars and plugin packages (Cloudflare R2), and DNS/TLS. That's it.

---

## Pricing Philosophy

### Generous defaults
Because Central's per-server cost is low, pricing can be generous. A family photo server with 5 users generating 2 heartbeats per minute costs UnCorded almost nothing. Pricing should reflect that — small servers should be cheap or free.

### Scales with usage
Larger servers (more users, more heartbeats, more marketplace activity) cost more to support. Pricing scales with a metric that correlates to actual infrastructure cost — likely **connected user count** or **monthly active users**, not arbitrary feature tiers.

### Transparent
The Rust analogy applies to pricing too. Rust server hosting is straightforward: you pay for the hardware and the listing. UnCorded should be similarly transparent: you pay for Central's services, and you know exactly what you're paying for.

### No feature gating
Every feature available to a server is available to every server. There is no "premium tier" that unlocks better plugins, more roles, or faster heartbeats. The runtime is the same for everyone. Pricing is about usage, not about artificial feature walls.

---

## Exact Pricing

**Not set.** Pricing depends on real cost data that only exists after servers are running in production.

What is known:
- Central's per-server cost is low (auth tokens + heartbeats + marketplace metadata)
- Pricing should scale with connected users or MAU
- Small servers (< 10 users) should be very cheap or free during early adoption
- The first paying customers will be the Phase 1 homelab and gaming audience — they expect pricing comparable to game server hosting ($5-15/month), not enterprise SaaS pricing

**Tagged: `[TBD-pricing]`** — exact tiers and formulas are deferred until real cost data exists from Phase 1 servers.

---

## Payment Processing

- **Stripe** for payment processing. Stripe handles subscriptions, invoicing, tax collection (Stripe Tax), and compliance.
- **Billing is tied to the server owner's UnCorded account**, not to the server itself. One account can own multiple servers; billing covers all of them.
- Server creation in the desktop wizard includes a payment step if the owner doesn't already have an active subscription.

---

## What Happens When Payment Lapses

If a server owner's subscription lapses:

1. **Grace period** (configurable, default: 7 days). The server continues running normally. The owner sees a billing reminder in the admin panel and the desktop app.
2. **After grace period:** the server is **delisted** from the directory (not discoverable, invite links stop resolving). The container continues running locally — connected users stay connected, data is preserved.
3. **After extended lapse** (configurable, default: 30 days): Central stops responding to heartbeats for this server. The container still runs, but:
   - No new users can join (token validation requires Central)
   - Existing sessions degrade as cached keys age out
   - The server effectively becomes a local-only archive
4. **Data is never deleted by Central.** The server owner's data lives on their hardware. UnCorded cannot and does not delete it. Even a fully lapsed account retains its data on the owner's disk.

**The principle:** UnCorded never holds data hostage. Stopping payment degrades discoverability and auth verification, not data access. The owner's files, messages, and plugin data are always theirs.

---

## Summary

| Question | Answer |
|---|---|
| What's free? | Accounts and joining servers |
| What's paid? | Hosting a server (registering with Central, using auth/directory/marketplace) |
| Why is it cheap? | Central never proxies user content. Infrastructure cost per server is tiny. |
| How does pricing scale? | With connected users or MAU, not feature tiers |
| What payment processor? | Stripe |
| What happens if payment lapses? | Grace period → delisted → heartbeat stopped. Data is never deleted. |
| Are there feature tiers? | No. Every feature is available to every server. Pricing is usage-based. |

---

## Future Refinements

### Free tier for small servers
- **What changes:** Servers with fewer than N users (e.g., 5 or 10) could be free permanently. The infrastructure cost is negligible, and free small servers drive adoption and word-of-mouth.
- **Why not now:** Need real cost data to know where the free tier cutoff is sustainable. Offering "free forever" before knowing the per-server cost is a promise you can't evaluate.
- **What today's code must not do:** Billing logic must not assume all servers are paid. The server registration flow must support a `billing_status: "free" | "active" | "grace" | "lapsed"` field from day one, even if Phase 1 only uses "active" and "lapsed."

### Managed hosting as a paid tier
- **What changes:** UnCorded runs the container for users who don't want to self-host. This becomes a higher-priced tier because it includes actual compute and storage costs, not just Central services.
- **Why not now:** Managed hosting requires operational maturity the platform hasn't earned yet. See `spec-03-server-container.md` future refinements.
- **What today's code must not do:** Billing must not assume "one server = one physical machine the owner controls." The billing model should be "per server registered in Central" regardless of where the container runs.

### Transparency receipts
- **What changes:** Server owners see a breakdown of what they're paying for: "Auth service: $X. Directory listing: $Y. Marketplace access: $Z. Our margin: $M." Full transparency.
- **Why not now:** Can't show a cost breakdown before knowing the costs. Requires real operational data.
- **What today's code must not do:** The billing data model should store cost components separately (auth_cost, directory_cost, marketplace_cost), not just a single "amount" field. Even if the receipt UI isn't built, the data structure supports it.
