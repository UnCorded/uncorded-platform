interface AsnCache {
  asn: string;
  expiresAt: number;
}

const cache = new Map<string, AsnCache>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Returns the ASN string (e.g. "AS15169") or null on failure.
export async function lookupAsn(
  ip: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  if (ip === "unknown" || ip === "127.0.0.1" || ip === "::1") return null;

  const cached = cache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.asn;

  try {
    const res = await fetchFn(`http://ip-api.com/json/${ip}?fields=as`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const as = typeof data["as"] === "string" ? data["as"] : null;
    if (!as) return null;

    // Extract just the ASN number ("AS15169 Google LLC" → "AS15169")
    const asn = as.split(" ")[0] ?? as;
    cache.set(ip, { asn, expiresAt: Date.now() + CACHE_TTL_MS });
    return asn;
  } catch {
    return null; // network error, timeout, etc. — best-effort
  }
}
