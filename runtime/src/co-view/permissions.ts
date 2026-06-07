// Permission helpers for Co-View Sessions (spec-27 §Authorization Model).
//
// Two named permissions, both server-level:
//   - co-view.host     — required to *start* a session. Default off.
//   - co-view.moderate — required to kick from a session you do not host.
//
// Viewers need no permission — the host's invite (private) or absence-from-
// blacklist (public) is the gate. Visibility rules are enforced separately
// in handlers.ts because they depend on per-session whitelist/blacklist
// state, not the role engine.

import type { RolesEngine } from "../roles/engine";

export const CO_VIEW_HOST_PERMISSION = "co-view.host";
export const CO_VIEW_MODERATE_PERMISSION = "co-view.moderate";

export function canHostCoView(
  rolesEngine: RolesEngine,
  userId: string,
  isOwner: boolean,
): boolean {
  return rolesEngine.check(userId, CO_VIEW_HOST_PERMISSION, { userId, isOwner });
}

export function canModerateCoView(
  rolesEngine: RolesEngine,
  userId: string,
  isOwner: boolean,
): boolean {
  return rolesEngine.check(userId, CO_VIEW_MODERATE_PERMISSION, { userId, isOwner });
}

/**
 * Visibility gate for join requests. Whitelist is consulted in `"private"`
 * mode; blacklist in `"public"` mode. Owner bypass is honored: a server owner
 * may join any visible-to-them session even if not whitelisted. The host can
 * always join (handled by the start path setting them as the `host` member).
 */
export function isVisibleToUser(
  visibility: "public" | "private",
  whitelist: ReadonlySet<string>,
  blacklist: ReadonlySet<string>,
  userId: string,
  isOwner: boolean,
): { ok: true } | { ok: false; reason: "blacklisted" | "not_invited" } {
  if (isOwner) return { ok: true };
  if (visibility === "public") {
    if (blacklist.has(userId)) return { ok: false, reason: "blacklisted" };
    return { ok: true };
  }
  if (whitelist.has(userId)) return { ok: true };
  return { ok: false, reason: "not_invited" };
}
