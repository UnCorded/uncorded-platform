// Canonical avatar/cursor/pen color + initial extraction.
//
// Single source of truth so the runtime, web client, and plugin SDK all paint
// the same hue for the same id. Replaces three pre-existing schemes (16-color
// hex, 12-OKLCH client copy in 3 files) with a unified 37-hue HSL hash adapted
// from Excalidraw's `clients.ts`.
//
// Three roles per id, same hue family:
//   - background (pastel, hsl(h, 100%, 83%))  — avatar fill
//   - foreground (dark,   hsl(h, 60%, 18%))   — text on the pastel bg
//   - accent     (vivid,  hsl(h, 75%, 45%))   — cursor outline / pen stroke
//                                               (saturated for contrast on
//                                               arbitrary UI; pastel disappears
//                                               over light surfaces)

/** FNV-1a 32-bit hash — fast, dependency-free, good enough for color picks. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const HUE_BUCKETS = 37;

export interface ClientColor {
  /** Pastel — hsl(h, 100%, 83%). Avatar background. */
  background: string;
  /** Dark text — hsl(h, 60%, 18%). Legible on the pastel bg. */
  foreground: string;
  /** Saturated mid-luminance — hsl(h, 75%, 45%). Cursor + pen color. */
  accent: string;
}

export function getClientColor(id: string): ClientColor {
  const hue = (fnv1a(id) % HUE_BUCKETS) * (360 / HUE_BUCKETS);
  return {
    background: `hsl(${hue}, 100%, 83%)`,
    foreground: `hsl(${hue}, 60%, 18%)`,
    accent: `hsl(${hue}, 75%, 45%)`,
  };
}

/** Convenience for callers that want the cursor/pen-grade single string. */
export function getClientColorString(id: string): string {
  return getClientColor(id).accent;
}

const SEGMENTER: Intl.Segmenter | null =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/**
 * First visible character, uppercased. Returns "?" on empty/whitespace.
 *
 * Grapheme-cluster safe via Intl.Segmenter where available (handles emoji
 * with modifiers, ZWJ family sequences, regional indicators). Falls back to
 * Symbol.iterator (code-point safe) on legacy environments — note that the
 * fallback may split ZWJ sequences (e.g. "👨‍👩‍👧" → "👨"), which is acceptable
 * for an initials display.
 */
export function getNameInitial(name: string | undefined | null): string {
  if (!name) return "?";
  const trimmed = name.trim();
  if (trimmed.length === 0) return "?";

  if (SEGMENTER) {
    const first = SEGMENTER.segment(trimmed)[Symbol.iterator]().next();
    if (!first.done) return first.value.segment.toLocaleUpperCase();
  }

  for (const ch of trimmed) {
    return ch.toLocaleUpperCase();
  }
  return "?";
}
