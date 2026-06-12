import type { Server } from "../api/types";

/**
 * Narrow reactive key for "which server is active" effects (sidebar,
 * membership, permissions, runtime-update). Shaped as `id|tunnel_url` so
 * unrelated patchServer churn (is_online flips from onConnect, presence
 * counts, name edits) doesn't tear those effects down, while a tunnel
 * rotation does re-fire them.
 *
 * tunnel_url may be null when the server is selected: Central no longer
 * returns it in list/get responses — it is only revealed by the token mint
 * inside ws.connect(), which hydrates the store via patchServer. The key must
 * therefore NOT require tunnel_url. The effects keyed on it are the ones that
 * initiate connect() in the first place, so gating on the URL deadlocks:
 * no connect → no mint → no URL → no connect. A missing URL serializes as an
 * empty segment (`id|`); hydration changes the key and re-fires the effect,
 * which is how the HTTP-dependent loaders pick the URL up.
 */
export function activeServerKey(
  id: string | null,
  server: Server | null,
): string | null {
  if (!id || !server) return null;
  return `${id}|${server.tunnel_url ?? ""}`;
}

/** Split an `activeServerKey` back into its parts. tunnelUrl is "" pre-hydration. */
export function splitActiveServerKey(key: string): { id: string; tunnelUrl: string } {
  const sep = key.indexOf("|");
  return { id: key.slice(0, sep), tunnelUrl: key.slice(sep + 1) };
}
