/**
 * Pure helpers extracted from `avatar-stack.tsx` so they can be unit-tested
 * without pulling SolidJS / Kobalte client-only modules into the test process.
 */

/**
 * Accepts only `http(s)://` URLs. Filters out `javascript:`, `data:`, relative
 * paths, and non-strings — anything that could land as `<img src>` and surprise.
 * Returns the URL unchanged when safe, `null` otherwise (caller renders the
 * initial fallback).
 */
export function safeAvatarUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Tooltip text for the `+N` overflow badge. Lists the hidden members' names,
 * comma-separated; falls back to `"<N> more"` if no usable names are present.
 * Whitespace-only names are treated as empty.
 */
export function buildOverflowLabel(
  hidden: ReadonlyArray<{ name?: string }>,
  overflow: number,
): string {
  const names = hidden
    .map((it) => it.name?.trim())
    .filter((n): n is string => !!n && n.length > 0);
  return names.length > 0 ? names.join(", ") : `${String(overflow)} more`;
}
