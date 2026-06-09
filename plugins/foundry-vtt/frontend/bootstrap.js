// Panel bootstrap logic, factored out of index.html so it can be unit-tested
// without a browser. The DOM-wiring is intentionally tiny: mint a proxy-session
// cookie, then point both the iframe and the "Open in browser" link at the
// proxied URL the runtime hands back.
//
// Why a Bearer POST before setting iframe `src`: the proxy traffic itself is
// cookie-authenticated (the cross-site iframe carries the proxy-session cookie),
// but the cookie is only minted by an explicit, Bearer-authed bootstrap call.
// So the panel must complete bootstrap before the iframe navigates, otherwise
// the first proxied request arrives with no cookie and fails closed.

/**
 * Build the proxied mount URL for a plugin/mount pair.
 * This mirrors the runtime route contract (`/proxy/:slug/:mount/`) and is used
 * as the pre-bootstrap fallback for the "Open in browser" link so that link is
 * never pointed at the private upstream URL — only ever at the proxied route.
 *
 * @param {string} slug
 * @param {string} mount
 * @returns {string}
 */
export function proxiedMountUrl(slug, mount) {
  return `/proxy/${slug}/${mount}/`;
}

/**
 * Bootstrap the Foundry panel: POST for a proxy-session cookie, then wire the
 * iframe and fallback link to the proxied URL.
 *
 * Returns the proxied URL on success, or `null` if bootstrap failed (in which
 * case the iframe is left untouched and the link keeps its proxied fallback
 * href so "Open in browser" still works as a top-level navigation — the
 * Safari/WebKit path where the iframe cookie does not carry).
 *
 * @param {object} opts
 * @param {typeof fetch} opts.fetchImpl  fetch implementation (injectable for tests)
 * @param {string} opts.token            plugin session token (Bearer)
 * @param {{ src: string } | null} opts.frame  iframe element to navigate
 * @param {{ href: string } | null} opts.link  anchor element for the fallback
 * @param {string} opts.slug
 * @param {string} opts.mount
 * @returns {Promise<string | null>}
 */
export async function bootstrapFoundryPanel({ fetchImpl, token, frame, link, slug, mount }) {
  // Pre-seed the fallback link at the proxied route immediately, so even if the
  // bootstrap POST fails the user can still open the proxied URL top-level.
  if (link) link.href = proxiedMountUrl(slug, mount);

  let res;
  try {
    res = await fetchImpl(`/proxy-sessions/${slug}/${mount}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      credentials: "same-origin",
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const url = body?.url;
  if (typeof url !== "string" || url.length === 0) return null;

  if (frame) frame.src = url;
  if (link) link.href = url;
  return url;
}
