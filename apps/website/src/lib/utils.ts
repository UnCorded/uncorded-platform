import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// SSR-safe at-module-load mac detection. Apps that need this on first render
// don't have to wait for onMount, and we don't pay the cost on every call.
// `userAgentData` lands first when available; userAgent string is the fallback.
const isMac =
  typeof navigator !== "undefined" &&
  (/Mac|iPod|iPhone|iPad/.test(navigator.platform) ||
    /Mac OS X|Macintosh/.test(navigator.userAgent));

/** The platform-correct modifier glyph for keybind chips: ⌘ on macOS, Ctrl elsewhere. */
export const MOD_KEY = isMac ? "⌘" : "Ctrl";

/** Compose a keybind chip string, e.g. `mod("B")` → `"⌘B"` on macOS, `"Ctrl+B"` elsewhere. */
export function mod(key: string): string {
  return isMac ? `${MOD_KEY}${key}` : `${MOD_KEY}+${key}`;
}
