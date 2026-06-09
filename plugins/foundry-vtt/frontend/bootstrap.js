// Panel bootstrap logic, factored out of index.html so it can be unit-tested
// without a browser. The DOM-wiring is intentionally tiny: ask the SDK to
// bootstrap the proxy mount, then point the iframe at the proxied URL and the
// "Open in browser" link at the first-party fallback URL.
//
// This plugin is a reverse-proxy test consumer (NOT a bundled product plugin) —
// it exists to prove the generic `sdk.proxy` + runtime proxy capability against
// a Foundry-shaped upstream. It deliberately uses ONLY the blessed SDK surface
// (`sdk.proxy.openMount`), no hand-rolled `/proxy-sessions` fetch, so the path a
// real plugin author would take is the path under test.
//
// Why both URLs: `iframeUrl` carries the proxy-session cookie minted by the
// bootstrap (works framed on Chromium/Firefox). `openUrl` is the top-level
// fallback: Safari/WebKit stores no cookie set inside a cross-site iframe
// (Phase 0 §4a), so the framed load fails closed there and the user must use
// "Open in browser", which re-mints the cookie first-party via /proxy-open.

/**
 * Bootstrap the Foundry panel: open the proxy mount via the SDK, then wire the
 * iframe and fallback link.
 *
 * Returns the `{ iframeUrl, openUrl }` session on success, or `null` if the
 * bootstrap failed (in which case the iframe and link are left untouched and the
 * caller surfaces an error message).
 *
 * @param {object} opts
 * @param {(mount: string) => Promise<{ iframeUrl: string, openUrl: string }>} opts.openMount  `sdk.proxy.openMount`
 * @param {{ src: string } | null} opts.frame  iframe element to navigate
 * @param {{ href: string } | null} opts.link  anchor element for the fallback
 * @param {string} opts.mount  proxy mount name (declared in manifest.json)
 * @returns {Promise<{ iframeUrl: string, openUrl: string } | null>}
 */
export async function bootstrapFoundryPanel({ openMount, frame, link, mount }) {
  let session;
  try {
    session = await openMount(mount);
  } catch {
    return null;
  }
  if (!session || typeof session.iframeUrl !== "string" || typeof session.openUrl !== "string") {
    return null;
  }

  // Point "Open in browser" at the first-party handoff (never at the bare
  // /proxy/ route, which would 401 in Safari where the framed cookie is blocked).
  if (link) link.href = session.openUrl;
  if (frame) frame.src = session.iframeUrl;
  return session;
}
