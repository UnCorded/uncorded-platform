// If TURNSTILE_SECRET_KEY is not set, returns true (dev bypass).
// Always pass remoteip for better Turnstile accuracy.
export async function verifyCaptcha(
  token: string,
  remoteIp: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const secretKey = process.env["TURNSTILE_SECRET_KEY"];
  if (!secretKey) return true; // dev bypass — warn at startup instead

  const body = new URLSearchParams({
    secret: secretKey,
    response: token,
    remoteip: remoteIp,
  });

  try {
    const res = await fetchFn(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    );

    if (!res.ok) return false;
    const data = (await res.json()) as Record<string, unknown>;
    return data["success"] === true;
  } catch {
    return false; // network error, timeout, etc. — fail closed
  }
}
