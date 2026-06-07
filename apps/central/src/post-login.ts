// Where the user lands after a successful auth flow that originates from a
// link the user clicks (OAuth callback, email verification). Defaults to the
// Vite dev server so local flows work without extra wiring; production must
// set POST_LOGIN_REDIRECT explicitly — a wrong default here means users land
// on a URL that doesn't exist.
//
// Security: every browser-initiated auth response (OAuth callback,
// email verification) issues a 302 to this value while in the same response
// setting a fresh session cookie on Central's domain. A misconfigured or
// hostile value would not leak the cookie itself (it's __Host- scoped to
// Central), but it would phish the user — they'd land on attacker-controlled
// HTML moments after a real login. We validate at boot against an allowlist
// instead of trusting the operator to spell their own domain right.
export function getPostLoginRedirect(): string {
  return process.env["POST_LOGIN_REDIRECT"] ?? "http://localhost:5174";
}

export function isAllowedPostLoginRedirect(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // No userinfo, no query, no fragment — the auth handlers append `?error=…`
  // or `?verified=1` themselves and would otherwise produce malformed URLs.
  if (url.username !== "" || url.password !== "") return false;
  if (url.search !== "" || url.hash !== "") return false;
  // Trailing path is fine ("/" or "/auth"), but the path must be a clean
  // prefix the handlers can extend; reject anything that already carries a
  // "?" or "#" smuggled into the path component.
  if (url.pathname.includes("?") || url.pathname.includes("#")) return false;

  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return url.protocol === "http:";
  }

  if (url.protocol !== "https:") return false;
  if (url.hostname === "uncorded.app") return true;
  if (url.hostname.endsWith(".uncorded.app")) return true;
  return false;
}
