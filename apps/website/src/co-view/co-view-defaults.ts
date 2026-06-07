// Per-account Co-View defaults stored in localStorage.
//
// Why localStorage and NOT a Central endpoint: Central is identity-only and
// never holds user data per CLAUDE.md. Defaults are advisory pre-fills for
// the start-session sheet; the wire payload is always whatever the user
// submits. Defaults explicitly do NOT sync across devices — the profile
// section labels them "Saved on this device" so users don't expect cross-
// device follow.
//
// Keying: by Central account id, not server-scoped user_id, so the same
// human's preferences follow them across the servers they join.
//
// Forward-compat: `getCoViewDefaults` returns the spec-mandated defaults
// when no entry exists OR when the stored entry is malformed. Account
// settings is hard-coded into the redactions list because it's always-hidden
// per spec-27 §Threat Model — if the user removed it from their saved
// defaults via direct localStorage tampering, we re-add it on read.

import type {
  CoViewRedactions,
  CoViewRenderMode,
  CoViewVisibility,
} from "@uncorded/protocol";

/**
 * Redaction keys mirrored from spec-27 §Privacy & Redaction Model. Kept as a
 * narrow string union so the start-sheet's checkboxes can be derived without
 * a runtime lookup. Account settings is the only key that's mandatory; the
 * rest are user-toggleable.
 */
export type CoViewRedactionKey =
  | "account-settings"
  | "notifications"
  | "direct-messages"
  | "personal-files";

const ALWAYS_REDACTED: CoViewRedactionKey = "account-settings";

export interface CoViewDefaults {
  visibility: CoViewVisibility;
  renderMode: CoViewRenderMode;
  redactions: CoViewRedactionKey[];
}

const STORAGE_KEY_PREFIX = "co-view.defaults.";

const SPEC_DEFAULTS: CoViewDefaults = {
  visibility: "private",
  renderMode: "as-viewer",
  redactions: [ALWAYS_REDACTED],
};

function storageKey(accountId: string): string {
  return `${STORAGE_KEY_PREFIX}${accountId}`;
}

function safeStorage(): Storage | null {
  // Guarded for SSR / non-browser tests. Access can throw under strict
  // sandboxing (Safari private mode historically, certain Electron contexts).
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function isCoViewVisibility(value: unknown): value is CoViewVisibility {
  return value === "public" || value === "private";
}

function isCoViewRenderMode(value: unknown): value is CoViewRenderMode {
  return value === "as-host" || value === "as-viewer";
}

function isCoViewRedactionKey(value: unknown): value is CoViewRedactionKey {
  return (
    value === "account-settings" ||
    value === "notifications" ||
    value === "direct-messages" ||
    value === "personal-files"
  );
}

function normalizeRedactions(input: unknown): CoViewRedactionKey[] {
  if (!Array.isArray(input)) return SPEC_DEFAULTS.redactions.slice();
  const out: CoViewRedactionKey[] = [];
  for (const v of input) {
    if (isCoViewRedactionKey(v) && !out.includes(v)) out.push(v);
  }
  if (!out.includes(ALWAYS_REDACTED)) out.unshift(ALWAYS_REDACTED);
  return out;
}

/**
 * Read defaults for an account. Returns the spec-mandated defaults when no
 * entry exists, the entry can't be parsed, or required fields are missing.
 * Account-settings is always present in the returned redactions even if a
 * tampered entry omitted it.
 */
export function getCoViewDefaults(accountId: string): CoViewDefaults {
  const storage = safeStorage();
  if (!storage) return cloneDefaults(SPEC_DEFAULTS);
  const raw = storage.getItem(storageKey(accountId));
  if (raw === null) return cloneDefaults(SPEC_DEFAULTS);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return cloneDefaults(SPEC_DEFAULTS);
  }
  if (typeof parsed !== "object" || parsed === null) {
    return cloneDefaults(SPEC_DEFAULTS);
  }
  const obj = parsed as Record<string, unknown>;
  const visibility = isCoViewVisibility(obj["visibility"])
    ? obj["visibility"]
    : SPEC_DEFAULTS.visibility;
  const renderMode = isCoViewRenderMode(obj["renderMode"])
    ? obj["renderMode"]
    : SPEC_DEFAULTS.renderMode;
  const redactions = normalizeRedactions(obj["redactions"]);
  return { visibility, renderMode, redactions };
}

/**
 * Persist defaults for an account. The always-redacted key is force-included
 * before write. Silently no-ops when localStorage is unavailable (SSR /
 * sandboxed) — the start-sheet still works, the user just sees the spec
 * defaults next time.
 */
export function setCoViewDefaults(accountId: string, defaults: CoViewDefaults): void {
  const storage = safeStorage();
  if (!storage) return;
  const normalized: CoViewDefaults = {
    visibility: defaults.visibility,
    renderMode: defaults.renderMode,
    redactions: normalizeRedactions(defaults.redactions),
  };
  try {
    storage.setItem(storageKey(accountId), JSON.stringify(normalized));
  } catch {
    // Storage quota / disabled. Swallow — UI proceeds without persistence.
  }
}

/** Remove a saved defaults entry for an account. Used when the user clears
 *  their browser data through the profile sheet. */
export function clearCoViewDefaults(accountId: string): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.removeItem(storageKey(accountId));
  } catch {
    // ignore
  }
}

function cloneDefaults(d: CoViewDefaults): CoViewDefaults {
  return {
    visibility: d.visibility,
    renderMode: d.renderMode,
    redactions: d.redactions.slice(),
  };
}

/** Spec-mandated defaults exposed for tests + the profile sheet's reset button. */
export function getSpecCoViewDefaults(): CoViewDefaults {
  return cloneDefaults(SPEC_DEFAULTS);
}

/** True if the redaction key is always-on and should render disabled. */
export function isAlwaysRedacted(key: CoViewRedactionKey): boolean {
  return key === ALWAYS_REDACTED;
}

/** All known redaction keys, in canonical UI order. */
export const ALL_REDACTION_KEYS: readonly CoViewRedactionKey[] = [
  "account-settings",
  "notifications",
  "direct-messages",
  "personal-files",
] as const;

/** Display label for each redaction key, used by sheets and the profile section. */
export const REDACTION_LABELS: Record<CoViewRedactionKey, string> = {
  "account-settings": "Account settings",
  notifications: "Notifications",
  "direct-messages": "Direct messages",
  "personal-files": "Personal files",
};

/**
 * Map user-facing redaction keys → wire `CoViewRedactions` payload.
 *
 * The host shell hides DOM nodes by `data-co-view-panel` attribute; this maps
 * each toggle to the panel id our shell uses. Keys without a corresponding
 * panel land as a no-op (no panel matches), which is safe — the runtime
 * accepts them and the renderer just doesn't redact anything.
 *
 * Plugin-slug and custom-selector channels are intentionally empty here in
 * v1 — a future per-element toggle UI (deferred to PR-CV6) is what would
 * populate them.
 */
export function redactionsForWire(keys: readonly CoViewRedactionKey[]): CoViewRedactions {
  const panelIds: string[] = [];
  for (const k of keys) panelIds.push(k);
  return {
    panel_ids: panelIds,
    plugin_slugs: [],
    custom_selectors: [],
  };
}
