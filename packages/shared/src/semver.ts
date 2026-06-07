// Minimal semver utilities for the subset of ranges UnCorded supports.
// Supported formats: "1.2.3" (exact), "^1.2" or "^1.2.3" (caret range),
// "1.2" (bare major.minor, treated as ^1.2.0).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a strict semver version string (MAJOR.MINOR.PATCH).
 * Returns null if the string is not valid.
 */
export function parseSemver(version: string): SemverParts | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * Parse a semver range as used in manifests.
 * Accepts: "^1.2", "^1.2.3", "1.2", "1.2.3"
 * Returns the parsed floor version and whether it's a caret range.
 */
function parseRange(range: string): { parts: SemverParts; caret: boolean } | null {
  const caret = range.startsWith("^");
  const raw = caret ? range.slice(1) : range;

  // Try MAJOR.MINOR.PATCH first
  const full = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw);
  if (full) {
    return {
      parts: { major: Number(full[1]), minor: Number(full[2]), patch: Number(full[3]) },
      caret,
    };
  }

  // Try MAJOR.MINOR (patch defaults to 0)
  const short = /^(\d+)\.(\d+)$/.exec(raw);
  if (short) {
    return {
      parts: { major: Number(short[1]), minor: Number(short[2]), patch: 0 },
      caret,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Compare two semver tuples. Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareSemver(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

// ---------------------------------------------------------------------------
// Range satisfaction
// ---------------------------------------------------------------------------

/**
 * Check whether a concrete version satisfies a semver range.
 *
 * Rules:
 * - Caret range (`^X.Y` or `^X.Y.Z`): same major, version >= range floor.
 *   For ^0.Y.Z: same major AND minor, patch >= range patch (caret with major 0
 *   pins to minor per npm convention).
 * - Bare version (`X.Y` or `X.Y.Z`): treated as caret range (same behavior).
 *
 * @param version - Concrete version string, e.g. "1.3.0"
 * @param range   - Range string, e.g. "^1.2" or "^1.0.0"
 * @returns true if version satisfies range
 */
export function satisfiesRange(version: string, range: string): boolean {
  const ver = parseSemver(version);
  if (!ver) return false;

  const rangeResult = parseRange(range);
  if (!rangeResult) return false;

  const floor = rangeResult.parts;

  // Major must always match
  if (ver.major !== floor.major) return false;

  // For major 0: caret pins to minor (npm convention)
  if (floor.major === 0) {
    if (ver.minor !== floor.minor) return false;
    return ver.patch >= floor.patch;
  }

  // For major >= 1: version must be >= floor
  return compareSemver(ver, floor) >= 0;
}
