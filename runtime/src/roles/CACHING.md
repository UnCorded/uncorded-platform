# Permission cache contract

`RolesEngine.check()` is on the WS client hot path: every authenticated WS
action that gates on a named permission calls it once. Today's
implementation is two SQLite reads (permissions row + role_permissions
override) per call. That's fine for Phase 1.5 throughput but will become a
bottleneck once PR-3 introduces voice-token issuance, which can fire many
checks per second per server.

This document defines the cache contract. Implementation lands when a hot
path measurably needs it — first candidate is `createJoinToken` in PR-4.
**Do not implement preemptively.**

## Cache key

```
(user_id, permission_key) → boolean
```

Owner status is resolved before the cache (caller passes `isOwner` from
the WS auth context). The cache only memoizes the role-resolution +
override-lookup work for non-owners.

## Cache value lifecycle — logical invalidation set

A cache entry is valid until **any** of the following invalidation events
fires for the affected user/role/permission. This table describes the
*logical* set of entries that must be invalidated; the v1 implementation
is allowed to collapse role-targeted events into a full flush (see
implementation note below).

| Event                                              | Logically invalidates                           |
| -------------------------------------------------- | ----------------------------------------------- |
| `assignRole(userId, ...)`                          | All entries for `userId`                        |
| `removeRole(userId, ...)`                          | All entries for `userId`                        |
| `grantPermission(roleId, key, ...)`                | All entries for users whose role.id = `roleId`  |
| `denyPermission(roleId, key, ...)`                 | All entries for users whose role.id = `roleId`  |
| `removePermissionOverride(roleId, key, ...)`       | All entries for users whose role.id = `roleId`  |
| `updateRole(id, { level })`                        | All entries for users whose role.id = `id`      |
| `deleteRole(id, ...)` (reassigns to member)        | All entries for affected users                  |
| `registerPermission` UPDATE of `default_level`     | All entries with `permission_key = key`         |
| User banned (`core.ban.create`)                    | All entries for `userId`                        |
| User unbanned (`core.ban.delete`)                  | All entries for `userId` (see note below)       |

Implementation note: the simplest correct cache is a `Map<userId,
Map<permKey, boolean>>` with O(1) per-user purge on user-targeted events.
**v1 may collapse every role-targeted or permission-targeted event into a
full flush** — these are administrative operations that fire rarely
compared to `check`, so the simpler invalidation path is fine. A reverse
index (role_id → users) is only worth building if profiling shows the
full-flush dominating.

Known-acceptable staleness: the `check` cache only stores positive/negative
permission results, not ban state itself (bans are gated upstream of
`check`). An unban race where the entry survives the 60s TTL is
acceptable — the worst case is a recently-unbanned user sees their old
denial result on the immediate next request, then reads fresh state on the
next cache miss. We flag the unban event for completeness, not because it
risks correctness in v1.

## TTL fallback

The cache MUST also expire entries after a hard TTL (default: 60s) as a
defense against missed invalidation. Every code path that mutates a row in
`roles`, `user_roles`, `permissions`, or `role_permissions` is responsible
for firing the matching invalidation event. The TTL is a backstop, not a
substitute for explicit invalidation.

## Cache miss path

On miss: run the existing two-query path in `RolesEngine.check`, store the
result, return. Misses must be cheap enough that we can keep an
upper bound on cache size (LRU eviction at, say, 10k entries) without
appreciable degradation.

## What this cache does NOT do

- Does not cache `getRole(userId)` results — different shape, different
  invalidation. If profiling shows it on the hot path, a separate cache
  with the same role-targeted invalidation rules.
- Does not memoize across processes — each runtime process has its own
  cache. Plugin subprocesses don't call `check` directly; they go through
  IPC.
- Does not cache negative owner lookups; owner status is computed
  upstream.

## When to implement

Trigger conditions (any one):

1. `RolesEngine.check` shows up in CPU profiles above 1% on a healthy
   server.
2. PR-4 `createJoinToken` ships and benchmarks show > 5ms p50 added by
   permission resolution.
3. A future named permission gates a sub-millisecond hot path (e.g.
   per-message `text-channels.send`).

Until then this file is the spec; the engine stays uncached.
