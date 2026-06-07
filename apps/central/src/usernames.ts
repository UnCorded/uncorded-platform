// Username normalization, validation, and reserved-name list.
//
// Per spec-06-authentication.md "Identity Model — Username vs. Display Name":
//   - Canonical form is lowercase ASCII.
//   - Charset is intentionally narrow: a-z, 0-9, _ only. No hyphens (URL/CLI
//     ambiguity), no dots (path-like collisions), no Unicode (homograph
//     attacks).
//   - Length 3–20.
//   - Reserved names rejected at registration AND at change time.
//
// Single source of truth for the reserved list. If any other module needs to
// know "is this username reserved?", import RESERVED_USERNAMES or call
// validateUsername(). Do not duplicate the list elsewhere.

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;

const USERNAME_RE = /^[a-z0-9_]+$/;

// Names that the system reserves. Sorted alphabetically by category for
// review-ability; lookup is O(1) via the Set below.
//
// "System" names protect against impersonating staff/automation.
// "Routing" names protect against collisions with route segments and
// future @-mention or vanity-URL paths (e.g. uncorded.app/@<username>).
const SYSTEM_RESERVED: readonly string[] = [
  "admin",
  "administrator",
  "root",
  "support",
  "help",
  "staff",
  "moderator",
  "mod",
  "system",
  "central",
  "uncorded",
  "official",
  "bot",
];

const ROUTING_RESERVED: readonly string[] = [
  "api",
  "app",
  "www",
  "mail",
  "email",
  "assets",
  "static",
  "cdn",
  "auth",
  "login",
  "register",
  "signup",
  "signin",
  "logout",
  "settings",
  "account",
  "profile",
  "home",
  "null",
  "undefined",
];

export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  ...SYSTEM_RESERVED,
  ...ROUTING_RESERVED,
]);

export type UsernameError =
  | "username_required"
  | "username_too_short"
  | "username_too_long"
  | "username_charset"
  | "username_reserved";

export interface UsernameOk {
  ok: true;
  /** Canonical (lowercase) form. Always use this for storage and lookup. */
  username: string;
}

export interface UsernameFail {
  ok: false;
  error: UsernameError;
}

export type UsernameResult = UsernameOk | UsernameFail;

/**
 * Normalize and validate a candidate username.
 *
 * Returns the canonical lowercase form on success, or a typed error code on
 * failure. The error code is stable and intended for client-side mapping to
 * specific UI messages (e.g. inline form validation hints). Callers should
 * also check uniqueness against the database — that's a separate concern this
 * module does not handle.
 */
export function validateUsername(input: unknown): UsernameResult {
  if (typeof input !== "string") return { ok: false, error: "username_required" };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, error: "username_required" };

  // Lowercase first so reserved-name and charset checks see the canonical
  // form. A user typing "Admin" should be told the name is reserved, not
  // that they used uppercase letters — the latter is a less actionable
  // error.
  const lower = trimmed.toLowerCase();

  if (lower.length < USERNAME_MIN_LENGTH) {
    return { ok: false, error: "username_too_short" };
  }
  if (lower.length > USERNAME_MAX_LENGTH) {
    return { ok: false, error: "username_too_long" };
  }
  if (!USERNAME_RE.test(lower)) {
    return { ok: false, error: "username_charset" };
  }
  if (RESERVED_USERNAMES.has(lower)) {
    return { ok: false, error: "username_reserved" };
  }

  return { ok: true, username: lower };
}

/**
 * Derive a candidate username from an email address. Used for migrating
 * existing accounts that predate the username field — strips the local part,
 * sanitizes to the username charset, and clamps to the length cap. Returns
 * the sanitized base; callers must still check uniqueness and append a
 * suffix on collision.
 *
 * Returns `null` if no valid candidate can be derived (e.g. a local-part of
 * "  " or one that sanitizes to under 3 chars).
 */
export function deriveUsernameFromEmail(email: string): string | null {
  const at = email.indexOf("@");
  const local = at === -1 ? email : email.slice(0, at);
  // Replace any character outside the username charset with underscore,
  // then collapse runs of underscores so we don't get user "_____" from a
  // weird email. Trim leading/trailing underscores so the canonical form
  // doesn't start with one (cosmetically nicer; not a hard rule).
  const sanitized = local
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (sanitized.length < USERNAME_MIN_LENGTH) return null;
  return sanitized.slice(0, USERNAME_MAX_LENGTH);
}

// Cooldown window for username changes. Stored on `accounts.username_changed_at`;
// a change is allowed iff that column is NULL or older than this window.
export const USERNAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
