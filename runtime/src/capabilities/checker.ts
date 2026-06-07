// Capability enforcement — checks whether a plugin's declared permissions
// allow a requested capability. Every IPC call from a plugin to the runtime
// passes through this gate. Undeclared capability = hard reject, no fallback.
//
// Permission grammar: resource.action[:scope]
//   - resource.action must match exactly
//   - scope supports trailing wildcard: events.publish:text-channels.*
//     matches events.publish:text-channels.message.created
//   - * alone as scope matches any scope value

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedCapability {
  resourceAction: string;
  scope: string | null;
}

export type CapabilityCheck =
  | { ok: true }
  | {
      ok: false;
      code: "CAPABILITY_DENIED";
      permission: string;
      plugin: string;
      message: string;
    };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Split a capability string into resource.action and scope.
 * Splits on the first `:` only — scope may contain additional colons
 * (e.g., `http.fetch:api.example.com:8080`).
 */
export function parseCapability(cap: string): ParsedCapability {
  const colonIndex = cap.indexOf(":");
  if (colonIndex === -1) {
    return { resourceAction: cap, scope: null };
  }
  return {
    resourceAction: cap.slice(0, colonIndex),
    scope: cap.slice(colonIndex + 1),
  };
}

// ---------------------------------------------------------------------------
// Scope matching
// ---------------------------------------------------------------------------

/**
 * Check if a declared scope pattern matches a requested scope.
 *
 * Rules:
 * - Both null → match (no scope on either side)
 * - One null, other not → no match
 * - Declared is `*` → matches any requested scope
 * - Declared ends with `.*` → prefix match: requested must start with
 *   the prefix (everything before `.*`) followed by `.` and at least
 *   one more character
 * - Otherwise → exact string match
 */
export function scopeMatches(
  declared: string | null,
  requested: string | null,
): boolean {
  if (declared === null && requested === null) return true;
  if (declared === null || requested === null) return false;

  // Global wildcard — matches any scope
  if (declared === "*") return true;

  // Trailing wildcard: "text-channels.*" matches "text-channels.anything"
  if (declared.endsWith(".*")) {
    const prefix = declared.slice(0, -2); // "text-channels"
    // Requested must be prefix + "." + at least one char
    return (
      requested.length > prefix.length + 1 &&
      requested.startsWith(prefix) &&
      requested[prefix.length] === "."
    );
  }

  // Exact match
  return declared === requested;
}

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

export class CapabilityChecker {
  private readonly parsed: readonly ParsedCapability[];

  constructor(
    private readonly pluginSlug: string,
    declaredPermissions: readonly string[],
  ) {
    this.parsed = declaredPermissions.map(parseCapability);
  }

  /**
   * Check if the requested capability is allowed by this plugin's
   * declared permissions. Returns a result object with denial details
   * on failure.
   */
  check(requested: string): CapabilityCheck {
    if (this.isAllowed(requested)) {
      return { ok: true };
    }

    return {
      ok: false,
      code: "CAPABILITY_DENIED",
      permission: requested,
      plugin: this.pluginSlug,
      message: `Plugin "${this.pluginSlug}" does not have permission "${requested}".`,
    };
  }

  /**
   * Quick boolean check — returns true if the requested capability
   * matches any declared permission.
   */
  isAllowed(requested: string): boolean {
    const req = parseCapability(requested);

    for (const declared of this.parsed) {
      if (declared.resourceAction !== req.resourceAction) continue;
      if (scopeMatches(declared.scope, req.scope)) return true;
    }

    return false;
  }
}
