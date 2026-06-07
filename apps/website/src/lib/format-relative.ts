// Tiny relative-time formatter using Intl.RelativeTimeFormat. Returns
// strings like "3 minutes ago", "2 days ago", "just now". For absolute
// dates older than 14 days falls back to a localized YYYY-MM-DD.
//
// Used by the administration roles list ("Last edited Nm ago") — anywhere
// else that wants the same formatting can import this helper instead of
// hand-rolling a switch on (now - ts).

const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/**
 * Format `ts` (epoch ms) relative to `now` (defaults to Date.now()).
 * Examples: "just now", "5 minutes ago", "3 days ago", "2026-04-01".
 *
 * - < 30 s ago → "just now"
 * - 14+ days  → ISO date (Intl.DateTimeFormat with date-only options)
 * - everything in between → Intl.RelativeTimeFormat with the largest
 *   unit that produces a non-zero magnitude.
 */
export function formatRelative(ts: number, now: number = Date.now()): string {
  const diff = ts - now;
  const absMs = Math.abs(diff);
  if (absMs < 30_000) return "just now";

  const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
  if (absMs >= FOURTEEN_DAYS_MS) {
    return new Date(ts).toISOString().slice(0, 10);
  }

  const seconds = Math.round(diff / 1000);
  const minutes = Math.round(diff / 60_000);
  const hours = Math.round(diff / 3_600_000);
  const days = Math.round(diff / 86_400_000);

  if (Math.abs(days) >= 1) return RTF.format(days, "day");
  if (Math.abs(hours) >= 1) return RTF.format(hours, "hour");
  if (Math.abs(minutes) >= 1) return RTF.format(minutes, "minute");
  return RTF.format(seconds, "second");
}
