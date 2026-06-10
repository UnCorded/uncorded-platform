// Pure, unit-testable policy for the reverse-proxy <webview> guest. The Electron
// wiring (session permission handlers, will-navigate, downloads) lives in
// main.ts and stays thin; the *decisions* it makes route through these
// functions so they can be tested without an Electron runtime.
//
// A proxy guest is pinned to a single mount: the runtime origin that served it
// and the `/proxy/<slug>/<mount>/` path prefix under which that mount lives.
// Anything off that origin or path is treated as an external link (opened in
// the OS browser, never navigated in-surface), and permissions are deny-by-
// default with an explicit allowlist that requires a native prompt.

/** A registered proxy mount's navigation pin, sent from the renderer at guest
 * attach time and stored per session partition in main. */
export interface ProxyMountRegistration {
  /** Session partition the guest runs in, e.g. `persist:proxy:<serverId>`. */
  partition: string;
  /** Runtime origin that served the mount, e.g. `https://srv-1.tunnel.example`. */
  mountOrigin: string;
  /** Path prefix the mount lives under, e.g. `/proxy/<slug>/<mount>/` (trailing slash). */
  mountPathPrefix: string;
}

/**
 * True iff `navUrl` stays within the guest's mount — same origin AND under the
 * mount's path prefix. Used by the guest `will-navigate` guard: a navigation
 * that fails this is an off-mount link (preventDefault + open externally).
 *
 * The path prefix carries a trailing slash, so a sibling mount
 * (`/proxy/slug/vtt2/`) does not match another's prefix (`/proxy/slug/vtt/`).
 */
export function isProxyNavAllowed(navUrl: string, mount: ProxyMountRegistration): boolean {
  let u: URL;
  try {
    u = new URL(navUrl);
  } catch {
    return false;
  }
  if (u.origin !== mount.mountOrigin) return false;
  if (mount.mountPathPrefix.length === 0) return false;
  // Allow the prefix itself (with or without the trailing slash) and anything
  // beneath it; reject siblings that merely share a string prefix.
  if (u.pathname.startsWith(mount.mountPathPrefix)) return true;
  return `${u.pathname}/` === mount.mountPathPrefix;
}

/** Electron permissions a proxy guest may even *ask* for. Everything else is
 * denied outright — the guest never gets, say, `openExternal` or `hid`. */
export const PROXY_PROMPTABLE_PERMISSIONS: ReadonlySet<string> = new Set([
  "media",
  "geolocation",
  "notifications",
  "midi",
  "midiSysex",
]);

/**
 * Decide what to do with a permission request from a proxy guest.
 *   - not in the promptable allowlist          → "deny"
 *   - remembered allow (true) / deny (false)   → that decision, no re-prompt
 *   - no remembered decision                   → "prompt" (native dialog)
 *
 * Never returns "allow" for an un-remembered request: a proxied third-party app
 * must not silently obtain camera/mic/location — the host always asks first.
 */
export function proxyPermissionDecision(
  remembered: boolean | null | undefined,
  permission: string,
): "allow" | "deny" | "prompt" {
  if (!PROXY_PROMPTABLE_PERMISSIONS.has(permission)) return "deny";
  if (remembered === true) return "allow";
  if (remembered === false) return "deny";
  return "prompt";
}
