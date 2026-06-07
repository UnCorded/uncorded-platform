// Scope grammar validation + auto-prefix helpers.
// Per spec-23-scoped-presence.md §"Scope Grammar".

import { PRESENCE_ERROR_CODES, PRESENCE_LIMITS } from "./types";
import type { PresenceError, PresenceResult } from "./types";

/**
 * Predicate for the spec's basic-sanity grammar:
 *   - ASCII printable (0x21..0x7E) — bars whitespace, tabs, controls
 *   - dot-delimited segments (the dots themselves count as printable)
 *   - 1+ chars
 *
 * The full-length cap is enforced AFTER prefixing in `prefixScope`.
 */
export function validateScope(unprefixed: string): PresenceResult<true> {
  if (typeof unprefixed !== "string" || unprefixed.length === 0) {
    return error("SCOPE_INVALID", "scope must be a non-empty string.");
  }

  for (let i = 0; i < unprefixed.length; i++) {
    const code = unprefixed.charCodeAt(i);
    // ASCII printable range, excluding space (0x20) and DEL (0x7F).
    if (code < 0x21 || code > 0x7e) {
      return error(
        "SCOPE_INVALID",
        `scope contains a non-printable or whitespace character at index ${String(i)} (charCode ${String(code)}). Allowed: ASCII 0x21..0x7E.`,
      );
    }
  }

  return { ok: true, value: true };
}

/**
 * Reject scopes whose first dot-segment matches an installed plugin slug
 * other than the calling plugin's. A scope without dots cannot collide; a
 * scope whose first segment names an UNINSTALLED slug-shaped string is
 * accepted (it could simply be a path component the calling plugin owns).
 *
 * Per the user's clarification on the spec gap: "starting with another
 * plugin's slug" is interpreted literally — we use the live plugin registry
 * as the slug set.
 */
export function crossPluginCheck(
  callerSlug: string,
  unprefixed: string,
  installedSlugs: ReadonlySet<string>,
): PresenceResult<true> {
  const dotIdx = unprefixed.indexOf(".");
  if (dotIdx === -1) return { ok: true, value: true };

  const firstSegment = unprefixed.slice(0, dotIdx);
  if (firstSegment === callerSlug) {
    // The plugin tried to write its own prefix — rejected because the
    // runtime adds the prefix; the plugin asking for it is a sign of confusion
    // that would produce a double-prefixed scope.
    return error(
      "CROSS_PLUGIN_SCOPE",
      `scope must not start with this plugin's own slug "${callerSlug}". The runtime auto-prefixes; pass the path only (e.g. "thread.abc.typing").`,
    );
  }
  if (installedSlugs.has(firstSegment)) {
    return error(
      "CROSS_PLUGIN_SCOPE",
      `scope first segment "${firstSegment}" is another installed plugin's slug. Plugins can only own scopes under their own namespace.`,
    );
  }
  return { ok: true, value: true };
}

/**
 * Auto-prefix the scope with the caller's slug and verify the final length is
 * within bounds. Returns the fully-qualified scope on success.
 */
export function prefixScope(
  callerSlug: string,
  unprefixed: string,
): PresenceResult<string> {
  const fq = `${callerSlug}.${unprefixed}`;
  if (fq.length > PRESENCE_LIMITS.SCOPE_LENGTH_MAX) {
    return error(
      "SCOPE_LENGTH",
      `scope length ${String(fq.length)} exceeds the ${String(PRESENCE_LIMITS.SCOPE_LENGTH_MAX)}-char cap (after prefixing with "${callerSlug}.").`,
    );
  }
  return { ok: true, value: fq };
}

function error(
  code: keyof typeof PRESENCE_ERROR_CODES,
  message: string,
): PresenceResult<never> {
  return { ok: false, error: { code: PRESENCE_ERROR_CODES[code], message } satisfies PresenceError };
}
