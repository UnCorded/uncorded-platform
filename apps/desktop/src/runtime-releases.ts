// Resolve the latest published runtime image version for a given update
// channel. Used by the orchestrator's check-for-update flow to decide
// whether to flip update-state to "available" or "up-to-date".
//
// Source of truth is the GitHub Releases API on `UnCorded/releases` (the
// public releases repo, same one the desktop installer uses). The platform
// source repo is private and unreachable anonymously, so cross-publishing
// to a public repo is mandatory for installed clients to discover updates.
// `release-runtime.yml` creates a draft GitHub Release on that repo named
// `runtime-<version>` at the end of every successful build; the operator
// promotes draft → published manually. Drafts are excluded from anonymous
// API listings so the unpublished-draft window is invisible to clients.
//
// Tag scheme: `runtime-<version>` lets the desktop installer's `v<version>`
// tags coexist on the same repo without cross-talk — `stripRuntimeTag`
// returns null for any tag missing the prefix.
//
// Channel filter:
//   stable: tag matches /^runtime-\d+\.\d+\.\d+$/
//   beta:   stable | /^runtime-\d+\.\d+\.\d+-beta(\.\d+)?$/
//   dev:    any /^runtime-/ (rc / dev / nightly variants all included)
//
// Returns null when no published version is greater than the current one
// (i.e. the operator is already up-to-date on this channel). Throws on
// network / parse errors so the caller can surface them as an `error`
// state with `errorContext: "check"` per update-ux.md §4.4.

import type { RuntimeUpdateChannel } from "@uncorded/electron-bridge";

const RELEASES_URL =
  "https://api.github.com/repos/UnCorded/releases/releases?per_page=100";

interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
}

const TAG_PREFIX = "runtime-";

// Lexicographic-but-numeric sort over the X.Y.Z[-prerelease] portion. We
// roll our own rather than pull a dep — semver comparison for our own
// release tags is bounded enough that a stripped-down implementation is
// more auditable than a fourth-party. Behavior matches semver §11 for the
// shapes we publish (X.Y.Z and X.Y.Z-beta.N / -dev.N / -rc.N).
function compareVersions(a: string, b: string): number {
  const [aMain, aPre] = splitPre(a);
  const [bMain, bPre] = splitPre(b);
  const mainCmp = compareNumericTriple(aMain, bMain);
  if (mainCmp !== 0) return mainCmp;
  // Equal main: a release with no prerelease is greater than one with.
  if (aPre === null && bPre === null) return 0;
  if (aPre === null) return 1;
  if (bPre === null) return -1;
  return comparePreRelease(aPre, bPre);
}

function splitPre(v: string): [string, string | null] {
  const idx = v.indexOf("-");
  if (idx === -1) return [v, null];
  return [v.slice(0, idx), v.slice(idx + 1)];
}

function compareNumericTriple(a: string, b: string): number {
  const aParts = a.split(".").map((s) => Number.parseInt(s, 10));
  const bParts = b.split(".").map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < 3; i += 1) {
    const ai = aParts[i] ?? 0;
    const bi = bParts[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

function comparePreRelease(a: string, b: string): number {
  const aParts = a.split(".");
  const bParts = b.split(".");
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
    const ap = aParts[i];
    const bp = bParts[i];
    if (ap === undefined) return -1;
    if (bp === undefined) return 1;
    const aNum = /^\d+$/.test(ap) ? Number.parseInt(ap, 10) : null;
    const bNum = /^\d+$/.test(bp) ? Number.parseInt(bp, 10) : null;
    if (aNum !== null && bNum !== null) {
      if (aNum !== bNum) return aNum - bNum;
      continue;
    }
    // Mixed: numeric identifiers always have lower precedence than
    // alphanumeric per semver §11.4.3.
    if (aNum !== null) return -1;
    if (bNum !== null) return 1;
    if (ap < bp) return -1;
    if (ap > bp) return 1;
  }
  return 0;
}

/** True iff `version` (e.g. "0.2.0", "0.2.0-beta.1") is published on the
 *  channel — used so e.g. dev-channel users can see beta + stable + dev
 *  versions, but stable-channel users only see stable releases. */
export function matchesChannel(
  version: string,
  channel: RuntimeUpdateChannel,
): boolean {
  if (!/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/.test(version)) return false;
  const isStable = !version.includes("-");
  if (channel === "stable") return isStable;
  if (channel === "beta") return isStable || /-beta(\.\d+)?$/.test(version);
  return true; // dev: everything that parses as a version
}

/** Strip the `runtime-` prefix from a release tag, returning null if the
 *  tag doesn't match the runtime convention (so a desktop-app release tag
 *  like `desktop-1.2.0` is silently filtered out). */
export function stripRuntimeTag(tag: string): string | null {
  if (!tag.startsWith(TAG_PREFIX)) return null;
  const version = tag.slice(TAG_PREFIX.length);
  if (!/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/.test(version)) return null;
  return version;
}

export interface ResolveLatestArgs {
  channel: RuntimeUpdateChannel;
  /** RUNTIME_VERSION the running container reports today. Anything ≤ this
   *  is filtered out of the result. */
  currentVersion: string;
  /** Optional injection seam for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Returns the newest version published on `channel` that's strictly
 * greater than `currentVersion`, or null when the runtime is up-to-date.
 * Throws on network / shape errors so the caller can map to an `error`
 * state with errorContext: "check".
 */
export async function resolveLatestVersion(
  args: ResolveLatestArgs,
): Promise<string | null> {
  const fetchImpl = args.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(RELEASES_URL, {
      headers: {
        // GitHub API requires a User-Agent for unauthenticated requests
        // (returns 403 otherwise). Identify ourselves so abuse can be
        // traced to the desktop app rather than a bare scraper signature.
        "User-Agent": "UnCorded-Desktop",
        Accept: "application/vnd.github+json",
      },
    });
  } catch (err) {
    throw new Error(
      `GitHub Releases fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // 404 on /repos/X/Y/releases means the repo exists but has no published
  // releases yet (or the listing endpoint shape changed — vanishingly rare
  // for GitHub). Functionally identical to "the array is empty", so map to
  // the up-to-date case rather than dumping a 404 body into the error pill.
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `GitHub Releases returned ${String(response.status)}: ${body.slice(0, 200)}`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    throw new Error(
      `GitHub Releases response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(payload)) {
    throw new Error("GitHub Releases response was not an array");
  }

  const candidates: string[] = [];
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) continue;
    const release = entry as Partial<GithubRelease>;
    if (release.draft === true) continue;
    if (typeof release.tag_name !== "string") continue;
    const version = stripRuntimeTag(release.tag_name);
    if (version === null) continue;
    if (!matchesChannel(version, args.channel)) continue;
    candidates.push(version);
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => compareVersions(b, a));
  const newest = candidates[0]!;
  if (compareVersions(newest, args.currentVersion) <= 0) return null;
  return newest;
}
