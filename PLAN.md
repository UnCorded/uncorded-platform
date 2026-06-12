# feat/server-membership — living progress tracker

Server membership, invites & auth-gating. Also the root-cause fix for the
"long-inactive server vanishes from the list → client purges local data" bug:
the sidebar moves off the online-filtered public directory onto
`GET /v1/me/servers`, which returns your memberships regardless of liveness.
Central already never deletes inactive rows; the leak was the list source.

## Test environment

Dev Postgres `uncorded-pg` holds :5432, so run Central tests against the
`uncorded-pg-test` container on :55433:

```bash
docker start uncorded-pg-test
DB_PORT=55433 DATABASE_URL=postgres://postgres:postgres@localhost:55433/uncorded_central_test bun test apps/central
```

Baseline (52e9acb): 325 pass / 1-2 fail — `voice-probe.test.ts` TCP
reachability tests fail on this machine regardless of changes (real-network
probe behavior). Gate = no NEW failures.

## Commits

- [ ] **1 — Membership schema + owner auto-join + quotas (Central)**
      Migration 006 + schema.sql: `server_members`, `server_invitations`
      (account-bound), `server_join_requests`. Backfill owner member rows for
      existing servers. handleCreateServer: owner member row in same tx +
      5-owned quota. Transfer confirm keeps member rows consistent. Tests.
- [ ] **2 — Capability hardening (Central)**
      tunnel_url stripped from GET /v1/servers + GET /:id; returned only by
      POST /v1/auth/token/server (bundled with token). Private non-member
      GET /:id → 404. server-token: active-member-or-owner check, banned
      denied. Regression tests.
- [ ] **3 — Sidebar source + invites + requests + kick/ban (Central)**
      GET /v1/me/servers; invites create/list/accept/decline/revoke (20-active
      cap, 15-joined quota at accept); join requests; kick/ban; leave. Tests.
- [ ] **4 — Two-phase delete + slot reaper (Central)**
      deleting → cascade → slot freed on confirmed purge. Runtime purge
      handshake stubbed with a clear seam.
- [ ] **5 — Client sidebar → /v1/me/servers**
      loadServers() → /v1/me/servers; listServers() stays for Explore; desktop
      IPC; tunnel_url now flows from token mint (serverId→URL cache).
- [ ] **6 — Auth-gate with return-to**
      401 interceptor → pending intent → AuthPage → replay after login.
      Covers ?join=<id> deep links.
- [ ] **7 — Join surfaces (client)**
      Invite popup in selector; Explore + request-to-join; owner member
      mgmt (invite-by-username, requests, kick/ban) in server settings.
- [ ] **8 — Integration test + green gates**

## Notes / decisions

- servers.owner_id stays the single source of owner truth; server_members.role
  ('owner'|'member') mirrors it for listing, and every owner_id change
  (create, transfer) maintains the mirror in the same transaction.
- Invites are account-bound (invited_account_id), not open invite links.
- Quotas: 5 owned (create), 15 joined (invite-accept / request-accept),
  20 active invites per server (invite create).
