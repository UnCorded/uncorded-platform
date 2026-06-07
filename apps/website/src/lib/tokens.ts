// In-memory token cache for server auth tokens.
// Tokens are never written to localStorage or sessionStorage.

interface TokenEntry {
  token: string;
  expiresAt: number; // Unix seconds
  refreshTimer: ReturnType<typeof setTimeout> | null;
}

const cache = new Map<string, TokenEntry>();

export function storeToken(
  serverId: string,
  token: string,
  expiresAt: number,
  onRefresh: (serverId: string) => void,
): void {
  clearToken(serverId);

  // Refresh 60s before expiry
  const refreshIn = (expiresAt - Date.now() / 1000 - 60) * 1000;
  const timer =
    refreshIn > 0
      ? setTimeout(() => onRefresh(serverId), refreshIn)
      : null;

  cache.set(serverId, { token, expiresAt, refreshTimer: timer });
}

export function getToken(serverId: string): string | null {
  const entry = cache.get(serverId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now() / 1000) {
    clearToken(serverId);
    return null;
  }
  return entry.token;
}

// Same expiry handling as getToken, but returns the WS-shaped { token, expires_at }
// so the WS open path can reuse a still-valid cached token without a Central call.
// Naming kept distinct so getToken's string-returning callers don't change.
export function getCachedToken(
  serverId: string,
): { token: string; expires_at: number } | null {
  const entry = cache.get(serverId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now() / 1000) {
    clearToken(serverId);
    return null;
  }
  return { token: entry.token, expires_at: entry.expiresAt };
}

export function clearToken(serverId: string): void {
  const entry = cache.get(serverId);
  if (entry?.refreshTimer !== null && entry?.refreshTimer !== undefined) {
    clearTimeout(entry.refreshTimer);
  }
  cache.delete(serverId);
}

export function clearAllTokens(): void {
  for (const id of cache.keys()) {
    clearToken(id);
  }
}
