---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Security is not optional"
depends-on: [spec-01-vision-and-wedge, spec-03-server-container]
last-verified: 2026-04-30
---

# 06 — Authentication, Identity, and Roles

*How users prove who they are, how servers verify them, how ownership works, how roles work, and how the admin panel is secured.*

---

## Account Creation

UnCorded accounts are **free.** Two registration methods ship in Phase 1:

### Email + Password
- User provides email + password.
- **Email verification required** — clicking a link in a confirmation email. Not just email-on-file.
- Password hashing: Argon2id (memory-hard, current best practice).
- Password requirements: minimum 8 characters. No complexity theater (no "must include uppercase and a symbol"). Length is the strongest predictor of password security.

### OAuth Providers (Google, Discord, GitHub)
- "Sign in with Google/Discord/GitHub" — one-click registration via OAuth 2.0.
- Central receives the provider's user ID, email, display name, and avatar. No provider password is ever seen or stored.
- If the provider email matches an existing account **and** the provider confirms the email is verified, the provider is auto-linked to the existing account on first login.
- Users can have **multiple providers linked to one account**. Provider emails do not need to match — a user might have Google on one email and Discord on another. Both link to the same UnCorded account.

**Why these three:** everyone has an email, most have a Google account, and the target audience (gamers and homelab builders) overwhelmingly has Discord and GitHub.

### Provider Linking (from account settings)

Two distinct OAuth flows exist:

1. **Login/Register** (unauthenticated) — OAuth callback creates a new account or logs into an existing one.
2. **Link provider** (authenticated) — user is already logged in, clicks "Link Discord" in settings → OAuth redirect → callback links that provider to their *current* account, regardless of email match.

The OAuth `state` parameter carries the intent: `{ mode: "login" }` vs `{ mode: "link", accountId: "..." }`.

**Linking rules:**
- A provider ID can only be linked to one account. If the provider ID is already linked to a different account, the link attempt fails with an error.
- Users can unlink a provider from their account, **as long as** they still have a password set OR at least one other provider linked. You cannot remove your last authentication method.
- `GET /v1/auth/profile` returns the list of linked providers (names only, not provider IDs).
- `DELETE /v1/auth/providers/:provider` removes a linked provider. Requires session auth.

**Email verification safety:** Only auto-link a provider to an existing account (during login/register flow) if the provider confirms the email is verified. Google provides `verified_email`, Discord provides `verified`, GitHub provides `verified` on the emails endpoint. Unverified emails create a new account instead of linking.

### Anti-Abuse on Registration

- **CAPTCHA** on every registration (email+password and OAuth).
- **Per-IP rate limit:** 3 registrations per IP per hour.
- **Per-ASN rate limit:** 20 registrations per ASN per hour (catches distributed abuse from the same ISP).
- **Optional invite-only mode:** Central can be configured to require an invite code during early Phase 1 as a defensive posture while the user base is small.

---

## Identity Model — Username vs. Display Name

Every account has **two distinct identity fields**, plus the email and password covered above. They serve different purposes and must not be conflated.

| Field | Purpose | Uniqueness | Charset | Editable | Visible to others |
|---|---|---|---|---|---|
| **`username`** | Stable handle / login identifier / @-mention target | Globally unique, case-insensitive | `[a-z0-9_]{3,20}` (lowercase letters, digits, underscore) | Yes — rate limited to **once every 30 days** | Yes |
| **`display_name`** | Human-readable label rendered everywhere a name appears | Not unique | Unicode, NFC-normalized, length ≤ 32 visual chars (after grapheme cluster count); leading/trailing whitespace trimmed; control chars stripped | Yes — no cooldown | Yes |
| `email` | Login + notifications + recovery | Globally unique, case-insensitive | RFC 5321/5322 compliant | Yes — re-verification required | No (private) |
| `password` | Authentication factor | n/a | Argon2id-hashed; min 8 chars | Yes — current password required | No |

### Username rules

- **Canonical form is lowercase.** Input is lowercased before insert/lookup. The canonical form is what's stored, displayed in `@mentions`, used in URLs, and compared for uniqueness. We do not preserve a "display casing" of the username — that role belongs to `display_name`.
- **Charset is intentionally narrow** in Phase 1: `a-z`, `0-9`, `_`. No hyphens (URL/CLI ambiguity), no dots (path-like collisions), no Unicode (homograph attacks). Reserved for later expansion only after we see real usage friction.
- **Length 3–20.** Three-char minimum prevents trivial enumeration (`a`, `xx`); twenty-char ceiling keeps `@mention` rendering predictable.
- **Reserved names rejected at registration and at change time:**
  - System: `admin`, `administrator`, `root`, `support`, `help`, `staff`, `moderator`, `mod`, `system`, `central`, `uncorded`, `official`, `bot`
  - Routing: `api`, `app`, `www`, `mail`, `email`, `assets`, `static`, `cdn`, `auth`, `login`, `register`, `signup`, `signin`, `logout`, `me`, `settings`, `account`, `profile`, `home`, `null`, `undefined`
  - The reserved list lives at `apps/central/src/usernames.ts` (single source of truth) and is checked on both initial pick and rename.

### Login accepts username **or** email

`POST /v1/auth/login` accepts a single `identifier` field (renamed from `email`):
- If the identifier contains `@`, treat as email.
- Otherwise, lowercase and treat as username.

Both lookups hit a single index covering `(LOWER(email))` and `(LOWER(username))`. The 401 response message is identical for "no such identifier", "wrong password", and "account locked" — no oracle for whether a username/email is registered.

The `/auth/register` endpoint accepts `username`, `display_name`, `email`, `password`, `captcha_token`. Username collisions return a typed error (`username_taken`) so the form can highlight the field. We do **not** auto-suggest an alternative — naming is the user's choice.

### Username changes (1 per 30 days)

The `accounts` table gains `username_changed_at TIMESTAMPTZ`. A change is allowed iff `username_changed_at IS NULL OR username_changed_at < now() - INTERVAL '30 days'`. The endpoint is `PATCH /v1/auth/profile` with `{ "username": "<new>" }`; the response on cooldown returns `429` with `{ code: "username_cooldown", retry_after_seconds: <int> }`. The settings UI reads this field on profile load and disables the input with a "you can change this again on YYYY-MM-DD" hint when within the window.

The cooldown is **per-account, not per-username**: claiming a name and immediately releasing it does not let someone else immediately re-claim and shed it — they're under their own account's 30-day clock. Old usernames are released immediately into the pool on change; we do not park them. (See "Future refinements" for the username-history option if reclaim abuse becomes a real problem.)

`display_name` and `email` changes have no cooldown. `email` changes require re-verification (the account drops `email_verified` to `false` and a new verification mail is sent; the old session remains valid until the user logs out).

### What's stored on the account

```sql
ALTER TABLE accounts
  ADD COLUMN username TEXT,                          -- nullable during migration window only
  ADD COLUMN username_changed_at TIMESTAMPTZ;
CREATE UNIQUE INDEX accounts_username_lower_idx ON accounts (LOWER(username));
-- After migration backfill completes:
ALTER TABLE accounts ALTER COLUMN username SET NOT NULL;
```

Email already has a unique index. Both lookups use the lowercased form; never compare with raw user input.

### Migration of existing accounts

Production already has accounts with `display_name` only, no `username`. The transition runs in two steps:

1. **Backfill** (offline, one-shot): for each existing row, derive `username` from the email local-part — lowercase, strip non-`[a-z0-9_]`, truncate to 20 chars, append `_2`, `_3`, … on collision. `username_changed_at` is set to `NULL` so users start with a fresh 30-day clock if they want to change away from the auto-pick.
2. **Claim flow** (next sign-in): the SPA detects the auto-picked username (a server flag `username_auto_assigned: true` on `/auth/profile`) and surfaces a one-time "Pick your username" prompt. Submitting the prompt uses the regular `PATCH /auth/profile` path — and because the migration set `username_changed_at = NULL`, the first claim doesn't burn the 30-day budget. Subsequent changes do.

Users who skip the prompt keep the auto-picked username; the prompt is dismissible and reappears each session until acknowledged (or they take any rename action).

### What appears in the JWT and across the wire

The server auth token grows a `username` claim alongside `display_name`. The token's `display_name` continues to be what plugins render; `username` is what the runtime uses for stable identifiers, audit logs, and `@mention` resolution. The user-profile delta in heartbeat responses also gains `username`:

```json
{ "type": "user.profile_changed", "user_id": "abc", "username": "justin", "display_name": "Justin", "avatar_url": "..." }
```

Plugins that store user-derived data should key on `user_id`, never on `username` — usernames are stable but mutable; `user_id` is immutable.

### Settings sheet surface

The account settings sheet exposes four editable fields, each in its own row with inline validation and a Save button per row (avoids the "all-or-nothing" form pattern that punishes typos):

- **Username** — disabled if cooldown active; shows next-eligible date. Validates charset live; surfaces `username_taken` after submit.
- **Display name** — free text, NFC-normalized on save.
- **Email** — re-verification banner replaces the address until the new one is verified; old email continues to receive notifications during the window.
- **Password** — current + new + confirm. Argon2id verify on current.

OAuth-only accounts (no password set) hide the password row and surface "Set a password" instead, which provisions the first password without the current-password check.

---

## The Auth Flow (Steam/Rust Model)

### How a user connects to a server

```
[1] User logs into UnCorded app (web or desktop)
    → App sends credentials to Central
    → Central validates, sets a session cookie:
      __Host-session: HTTP-only, Secure, SameSite=Strict
    → User is now logged into UnCorded (not into any server yet)

[2] User clicks a server in the directory (or follows an invite link)
    → App calls Central: POST /v1/auth/token/server { server_id }
    → Central checks: is this user's account valid? Not banned?
    → Central returns a short-lived server auth token (JWT, 5-10 min TTL)

[3] App connects to the server's tunnel URL via WebSocket
    → First message includes the server auth token
    → Server validates the token signature against Central's cached public key
    → If valid → user is connected and authenticated
    → If invalid or expired → connection rejected

[4] User is now in the server
    → All further communication happens over this WebSocket
    → The server knows: user ID, display name, avatar, is_owner flag
    → Plugins see the authenticated user via sdk.permissions and auth.currentUser
```

### What's in the server auth token (JWT)

```json
{
  "header": {
    "alg": "EdDSA",
    "kid": "central-key-2026-04"
  },
  "payload": {
    "sub": "user_abc123",
    "server_id": "server_xyz",
    "username": "justin",
    "display_name": "Justin",
    "avatar_url": "https://central.uncorded.app/avatars/abc123.webp",
    "is_owner": true,
    "iat": 1712345678,
    "exp": 1712346278,
    "jti": "tok_unique_id"
  }
}
```

- **Signed with Ed25519** (EdDSA). Fast, small signatures, no RSA bloat.
- **Short-lived:** 5-10 minutes. The shell refreshes before expiration and pushes the new token to plugin iframes via postMessage.
- **`jti` (token ID):** unique per token. The server can track seen `jti` values to prevent replay within the token's lifetime.
- **`is_owner`:** Central is the authority on ownership. The server reads this flag to grant owner-level access.

### How the server validates without calling Central every time

1. On first heartbeat, the server receives Central's **public key bundle** — the set of Ed25519 public keys Central currently uses for signing.
2. To validate a token, the server checks the signature against the cached public keys. **No network call needed.**
3. If the signature is valid and the token is not expired → the user is in.
4. Key rotation: Central adds new keys before retiring old ones. The heartbeat delivers updated key bundles. Servers always have the current and previous keys cached.

### Key Rotation Lifecycle

Each signing key has a `kid` (key ID) and passes through four states:

| State | Meaning |
|---|---|
| `pending` | Generated, not yet signing. Published in heartbeat bundle so servers can pre-cache. |
| `active` | Currently used to sign all new tokens. Exactly one key is active at a time. |
| `retiring` | No longer signing, but tokens signed with it may still be valid (within their `exp`). Published in bundle during the overlap window. |
| `expired` | Past the overlap window. Removed from heartbeat bundles. Tokens signed with an expired key are rejected. |

**Rotation sequence:**
1. Central generates a new key → state `pending`. Published in next heartbeat bundle.
2. After one full heartbeat cycle (≥ 30 seconds), Central promotes the new key to `active`. The previous active key moves to `retiring`.
3. The `retiring` key remains in the heartbeat bundle for **the maximum server auth token TTL** (10 minutes). This guarantees that any token signed by the retiring key expires before that key is removed.
4. After the overlap window, the retiring key moves to `expired` and is dropped from all heartbeat bundles. Servers must reject tokens signed by an expired `kid`.

**Runtime requirements for a valid token:**
- `kid` header is required. Tokens without `kid` are rejected.
- `kid` must be present in the server's cached key bundle. Unknown `kid` → reject (do not fall back to any other key).
- `exp` and `iat` are required. Clock skew tolerance: ±30 seconds.
- `jti` is required and must not have been seen before within the token's lifetime (replay prevention via `JtiRevocationSet`).
- `alg` must be `EdDSA`. Tokens with `alg: "none"` or any HMAC algorithm are rejected unconditionally.
- `payload.server_id` must equal the runtime's own server ID from config. Tokens issued for other servers are rejected.
- **S10c prerequisite:** No `JwtPayload` type currently exists in `@uncorded/protocol`. S10c must add a named exported `JwtPayload` interface to `packages/protocol/src/` before implementing `server_id` binding in a type-safe way. The claim shape is defined inline in `apps/central/src/routes/server-token.ts`.

**Cached bundle freshness:**
- The runtime refreshes its key bundle on every successful heartbeat response.
- If the cached bundle is older than 2× the heartbeat interval (60 seconds), the runtime must treat any `kid`-not-found as a possible stale-cache problem and attempt one immediate heartbeat refresh before rejecting.
- If the refresh fails, the token is rejected (fail closed).

**Wire format (heartbeat response):**
The `public_keys` field in the heartbeat response is an array of objects, not an array of strings:
```json
{
  "public_keys": [
    { "id": "central-key-2026-04", "public_key": { "kty": "OKP", "crv": "Ed25519", "x": "..." } }
  ]
}
```
The runtime types in `runtime/src/heartbeat/types.ts` currently declare `public_keys: string[]` — this is a known mismatch that will be corrected in S10c.

---

## Token Storage Model

Where each token lives is a closed decision, not an open question.

| Token | Where it lives | Lifetime | Why |
|---|---|---|---|
| **Session token** | `__Host-` prefixed HTTP-only cookie on the Central domain. `Secure`, `SameSite=Strict`. On desktop (Electron): same cookie in the Chromium webview. | Long-lived (weeks), refreshable | JavaScript cannot read it (XSS-safe). `SameSite=Strict` blocks CSRF. `__Host-` prevents subdomain overwrite. Never travels to server tunnel URLs. |
| **Server auth token** | In-memory only in the shell app. Never persisted to disk, localStorage, cookies, or any storage. | 5-10 minutes | Short TTL limits blast radius if leaked. Shell holds it; plugins receive it only via postMessage. |
| **Plugin iframe token** | In-memory inside the plugin iframe. | Lifetime of the iframe, replaced by shell-pushed refreshes | Iframe is stateless about auth lifecycle. Holds one token at a time, swaps on refresh. |

**Tradeoff accepted:** `SameSite=Strict` means clicking an UnCorded link from an external site (email, chat) lands the user logged out on first navigation. Acceptable — GitHub and Discord make the same call.

---

## iframe Auth Delivery (postMessage Handshake)

Tokens are **never placed in the iframe URL.** Delivery is via `postMessage` only, with origin verification on both sides.

### Handshake sequence

```
[1] Shell loads iframe with plain src — no token, no fragment, no query string
[2] iframe finishes loading, posts { type: "uncorded.ready" } to parent
[3] Shell receives message, verifies:
    - event.source === iframe.contentWindow
    - event.origin === expectedPluginOrigin
    If either fails → message discarded
[4] Shell requests a fresh server auth token from Central
[5] Shell posts { type: "uncorded.token", token, expiresAt } to the iframe
[6] iframe verifies event.origin === expectedShellOrigin before trusting
[7] iframe uses the token for all WebSocket communication via the SDK
```

### Token refresh

**Shell pushes, iframe doesn't pull.** The shell tracks each active plugin iframe's token expiration and posts a fresh token before the old one expires. The iframe remains stateless about auth lifecycle.

---

## Heartbeat and Invalidation (Dirty Flag Optimization)

The server heartbeats Central every **30 seconds.** Most heartbeats have nothing to report — no bans, no profile changes, no revocations.

### Optimized heartbeat flow

```
Server → Central:
{
  server_id: "server_xyz",
  last_sync_version: 42,
  tunnel_url: "https://abc123.trycloudflare.com",
  runtime_version: "1.0.0",
  connected_users: 12,
  plugin_count: 5
}

Central checks: has anything changed for this server since version 42?

If nothing changed:
{
  dirty: false
}
← ~20 bytes. 99% of heartbeats look like this.

If something changed:
{
  dirty: true,
  sync_version: 45,
  deltas: [
    { type: "user.profile_changed", user_id: "abc", username: "newhandle", display_name: "New Name", avatar_url: "..." },
    { type: "user.banned", user_id: "xyz", reason: "ToS violation" },
    { type: "token.revoked", jti: "tok_old_id" },
    { type: "plugin.revoked", plugin_slug: "bad-plugin", version: "1.0.3" }
  ]
}
```

Server applies the deltas:
- Profile changes → update cached user info, notify connected clients
- Bans → disconnect the user immediately, reject future connections
- Token revocations → invalidate the specific token
- Plugin revocations → quarantine the plugin, stop loading it

Server updates `last_sync_version` to 45. Next heartbeat sends 45.

### What Central tracks per server

Central maintains a **version counter per server.** Whenever something relevant to a server changes (a connected user updates their profile, gets banned, has a token revoked), Central increments that server's version and stores the delta. On heartbeat, Central compares the server's `last_sync_version` to the current version and returns only the diff.

Deltas are retained for a configurable window (default: 24 hours). If a server's `last_sync_version` is older than the retention window (e.g., server was offline for a day), Central returns a full state snapshot instead of a diff.

---

## Ownership

**Ownership lives on Central.** The server container never stores or decides ownership — it receives the owner identity from Central.

### How ownership works

- When a server is created via the desktop wizard, Central records: `server_xyz owned by user_abc`.
- Every server auth token for the owner includes `is_owner: true`.
- The runtime checks this flag for owner-level operations: installing plugins, accessing `/admin/`, deleting the server, changing server settings.

### Ownership transfer

1. Current owner requests transfer via the admin panel or desktop app.
2. Central validates the request (must come from the current owner's authenticated session).
3. Central updates the ownership record: `server_xyz owned by user_def`.
4. Next heartbeat, the server receives a delta: `{ type: "ownership.transferred", new_owner: "user_def" }`.
5. The runtime updates its cached owner identity. The old owner's token no longer has `is_owner: true` on next refresh.

### What if Central is down?

The server caches the owner identity from the last successful heartbeat. During a Central outage, the cached owner retains access. New ownership transfers cannot happen until Central returns — because Central is the authority.

---

## Built-In Roles System

Roles are **runtime infrastructure**, not a plugin. Every server has them. Every plugin can query them. They are always present, always consistent.

**Why roles are not a plugin:** every plugin needs to check permissions. If permissions were a plugin that could be uninstalled, every plugin would need to handle the "no permissions available" case. That creates a category of bugs that should not exist. Roles are infrastructure — like auth, like the event bus, like the plugin loader. Server owners see custom roles from day one and understand this is built-in for a reason.

### Default roles

Every server starts with four roles that cannot be deleted:

| Role | Level | Who assigns it | What they can do |
|---|---|---|---|
| **Owner** | 100 | Central (automatic) | Everything. Install/remove plugins, manage all roles, access admin panel, delete server, transfer ownership. One per server. Cannot be removed or demoted. |
| **Admin** | 80 | Owner | Manage plugins, manage roles (except owner), ban/kick users, access admin panel, configure server settings. |
| **Moderator** | 60 | Owner or Admin | Kick/mute users, delete content, manage channels. Cannot touch plugins or server settings. |
| **Member** | 10 | Automatic on join | Use the server. Post in channels, use plugins. Default role for anyone who joins. |

The **level number** (100, 80, 60, 10) defines hierarchy. A role can only manage roles with a lower level than itself. An admin (80) can assign or remove moderators (60) and members (10) but cannot touch other admins or the owner.

### Custom roles

Admins and owners can create custom roles with specific permission sets:

```
Example: "Content Creator" role (level 40)
  Permissions: can post in announcement channels, can pin messages, can upload files > 50MB
  Cannot: kick users, manage other roles, access admin panel
```

Custom roles have a level between 1 and 99. The level determines where they sit in the hierarchy. A custom role at level 50 can be managed by moderators (60) and above, but cannot manage moderators.

### Permission system

The runtime provides a **permission check API** available to every plugin via the SDK:

```ts
// Check a specific permission
const canPost = await sdk.permissions.check(user.id, "channel.post", channelId)

// Get the user's role
const role = await sdk.permissions.getRole(user.id)

// Check if user has at least a certain role level
const isModOrAbove = await sdk.permissions.hasMinLevel(user.id, 60)

// Check if user has a specific role by name
const isAdmin = await sdk.permissions.hasRole(user.id, "admin")
```

### Plugin-defined permissions

Plugins can register their own permission types with the runtime:

```ts
// In the photo-gallery plugin backend
sdk.permissions.register("photo-gallery.upload", {
  description: "Can upload photos",
  default_level: 10  // Members and above can upload by default
})

sdk.permissions.register("photo-gallery.delete_others", {
  description: "Can delete other users' photos",
  default_level: 60  // Moderators and above by default
})
```

Server owners then see these permissions in the admin panel and can adjust them per role:

```
"Content Creator" role:
  [x] photo-gallery.upload        (allowed)
  [ ] photo-gallery.delete_others (denied — only mods+)
```

This means **plugins don't implement their own permission systems.** They register their permission types with the runtime, and the runtime handles the role-to-permission mapping. Consistent UI, consistent enforcement, zero per-plugin auth code.

### Where role data lives

Role data is stored in the **server container's runtime database** (`/data/core.db`), not in any plugin's database and not on Central.

Central knows exactly one thing: who owns the server. Everything else — admins, moderators, members, custom roles, permission overrides — is local to the server.

---

## Admin Panel

The server container serves an admin panel at **`/admin/`** on the tunnel URL. It is a lightweight web UI accessible from any browser, any device.

### Who can access it

- **Owner** and **Admin** roles only.
- Auth is the same UnCorded token used for regular server access — no separate login.
- The runtime checks the token, resolves the user's role, and grants or denies access.
- All other roles (moderator, member, custom roles below admin level) receive a 403.

### What the admin panel shows

- **Server status:** uptime, connected users, tunnel health, runtime version
- **Plugin management:** installed plugins, health status, resource usage, error logs, install/uninstall
- **Role management:** create/edit/delete custom roles, assign roles to users, configure permissions
- **User management:** connected users, ban/kick, view join history
- **Cascade panel:** pending/failed cascades with retry buttons
- **Audit log:** all admin actions with timestamps and who performed them
- **Server settings:** tunnel mode, permissive mode toggle (with the loud warning), resource limits

### Security hardening

- **Rate limiting** on `/admin/` endpoints — stricter than regular server endpoints.
- **Audit logging** for every admin action — who did what, when, irreversible log.
- **Session timeout** — admin sessions expire after 30 minutes of inactivity, requiring re-authentication.
- **No admin API without the UI** in Phase 1. All admin actions go through the web UI, not a raw API. This limits the attack surface to what the UI exposes.

---

## What This Auth Layer Does Not Solve

This is a deliberate design statement, not a caveat.

The auth layer handles **session theft**: stolen cookies, leaked URL tokens, XSS reading storage, cross-origin iframe attacks, replayed requests, stale tokens after a ban. Those are all closed.

It does **not** handle **plugin supply-chain attacks**: a malicious or compromised plugin that uses its own legitimately-issued token however it wants during its lifetime. If a user installs a bad plugin, that plugin's iframe holds a valid token and can make valid requests. Auth cannot distinguish "legitimate plugin doing its job" from "compromised plugin doing something the user didn't intend."

That class of attack is handled by **different layers**:
- **Marketplace trust tiers** (see `spec-11-marketplace.md`) — signature verification, static analysis, trust levels
- **Capability-based permissions** (see `spec-04-plugin-architecture.md`) — plugins can only call APIs they declared
- **Resource limits and watchdog** (see `spec-04-plugin-architecture.md`) — runaway plugins are quarantined
- **Revocation via heartbeat** — Central can revoke a compromised plugin version

These are separate layers by design. Auth handles identity. Marketplace trust handles publisher provenance. Capability permissions handle runtime authorization. Collapsing them would weaken all of them.

---

## Summary of Decisions

| Decision | Answer |
|---|---|
| Registration | Email + password (baseline) + Google OAuth. More providers later. |
| Identity fields | Separate **username** (unique, `[a-z0-9_]{3,20}`, 30-day rename cooldown) and **display_name** (free Unicode, ≤ 32 graphemes, no cooldown). Login accepts username or email. |
| Session token | `__Host-` HTTP-only cookie, `SameSite=Strict`, `Secure`, Central domain only |
| Server auth token | JWT with Ed25519 (EdDSA). 5-10 min TTL, in-memory only. |
| iframe auth | postMessage handshake, origin-verified both ways, shell pushes refreshes |
| Token validation | Server validates JWT signature against cached Central public keys. No network call. |
| Heartbeat | Every 30 seconds. **Dirty flag optimization** — `dirty: false` when nothing changed (~20 bytes). Deltas only when something changed. |
| Ownership | Lives on Central. Server receives via token `is_owner` flag. Transfer goes through Central. |
| Roles | **Runtime-built-in infrastructure**, not a plugin. Four default roles: owner (100), admin (80), moderator (60), member (10). Custom roles with levels 1-99. |
| Plugin permissions | Plugins register permission types with the runtime. Runtime handles role-to-permission mapping. Plugins check via `sdk.permissions.*`. |
| Admin panel | `/admin/` on the server tunnel URL. Owner + admin access only. Same auth as regular access + role check. |
| Admin security | Rate limiting, audit logging, 30-min session timeout, no raw API in Phase 1. |

---

## Future Refinements

### Two-factor authentication (2FA)
- **What changes:** Users can enable TOTP-based 2FA on their UnCorded account. Central requires the second factor on login. Server owners can require 2FA for admin-level roles.
- **Why not now:** Phase 1 audience (homelab, gaming) will tolerate not having 2FA. The auth flow works without it. Adding 2FA is additive — it doesn't change the token format or validation model.
- **What today's code must not do:** The session token flow must not assume single-factor auth. Leave room in the login endpoint response for a `requires_2fa: true` intermediate step that triggers a second round before issuing the session cookie.

### Phone/SMS verification as optional server policy
- **What changes:** Server owners can require that joining users have a phone-verified UnCorded account. Adds friction but strengthens identity for servers that need it.
- **Why not now:** Homelab audience would find it annoying. Professional-use-case servers (Phase 2+) are the consumers.
- **What today's code must not do:** The user identity payload in the server auth token must have room for verification flags (e.g., `phone_verified: true/false`). Include the field from day one even if it's always `false`.

### OAuth provider expansion
- **What changes:** Discord, GitHub, Apple, Microsoft sign-in options.
- **Why not now:** Email + Google covers the Phase 1 audience. Each provider is independent work. Ship the two that matter, add more based on user requests.
- **What today's code must not do:** The OAuth integration must be provider-agnostic in the Central codebase. One interface, multiple implementations. Adding a new provider should be a new file, not a refactor.

### Admin API (headless administration)
- **What changes:** The admin panel's functionality is exposed as a documented API for automation and scripting. Server owners can write scripts to manage their servers without the web UI.
- **Why not now:** Phase 1 limits the attack surface to the web UI. A raw API doubles the surface. Ship the UI first, stabilize it, then expose the API.
- **What today's code must not do:** The admin web UI must call internal functions, not be the functions. The admin logic should be a service layer the UI sits on top of — so the API can be added later as a second consumer of the same service layer, not a rewrite.

### Emergency revocation push channel
- **What changes:** Central pushes emergency revocations (CSAM, credible threats, account compromises) to running servers in real-time via WebSocket, out-of-band from the 30-second heartbeat.
- **Why not now:** At Phase 1 scale (small private servers), the 30-second window is acceptable. This becomes critical before the public directory opens.
- **What today's code must not do:** The heartbeat client must not be the only way the server can receive updates from Central. The server's Central connection handler should support both polling (heartbeat) and push (future WebSocket). Even if push isn't implemented, the architecture must not make it impossible. **This is HIGH PRIORITY for Phase 2 and gates the opening of the public server directory.**

### Username history / reclaim cooling-off
- **What changes:** Released usernames sit in a "cooling-off" pool for 60 days before re-issue, and a `username_history` table records the (user_id, old_username, released_at) so old `@mentions` and profile links can resolve to a "user is now @newhandle" stub.
- **Why not now:** The 30-day per-account rename cooldown already kills most squat-and-flip patterns. History tables grow forever and complicate GDPR delete; defer until we see real abuse or real complaints about broken @-mentions.
- **What today's code must not do:** Reclaim of a username happens immediately on rename. Don't bake assumptions about reclaim timing into URL routes — anything that resolves `/@<username>` must lookup at request time, never cache the username→user_id mapping past the request scope. That keeps the door open to add the cooling-off pool later as a single check, with no client/runtime change.

### Role inheritance and permission templates
- **What changes:** Roles can inherit permissions from a parent role. Permission templates let server owners start from a preset (e.g., "gaming community," "work team," "family") instead of configuring from scratch.
- **Why not now:** The four default roles cover Phase 1. Templates need real-world usage data to know what presets are useful.
- **What today's code must not do:** The role data model must support a `parent_role` field even if inheritance logic isn't implemented. A role with `parent_role: null` inherits nothing, which is the Phase 1 behavior.
