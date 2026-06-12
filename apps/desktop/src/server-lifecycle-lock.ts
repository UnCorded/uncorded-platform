// Per-server container-lifecycle lock. Three desktop flows stop/recreate a
// server's container — runtime updates (runtime-orchestrator), voice-hostname
// rebuilds (VOICE_SET_HOSTNAME), and dev-plugin deploys (plugin-dev-deploy) —
// and none of them can tolerate another running concurrently: both sides
// docker-rm the same container and re-run it with their own view of the
// registry record, so an interleaving strands a dead container id in the
// registry or double-creates against the same name/port.
//
// In-memory only (the desktop main process is the single orchestrator on a
// host), non-blocking by design: callers surface "busy" to the user rather
// than queueing — a queued container swap behind a multi-minute runtime
// update would fire long after the user stopped expecting it.

const held = new Set<string>();

export class ServerBusyError extends Error {
  constructor(public readonly serverId: string) {
    super("Another container operation is already running for this server.");
    this.name = "ServerBusyError";
  }
}

/** Non-throwing probe + acquire. Pair with releaseServerLifecycle in finally. */
export function tryAcquireServerLifecycle(serverId: string): boolean {
  if (held.has(serverId)) return false;
  held.add(serverId);
  return true;
}

export function releaseServerLifecycle(serverId: string): void {
  held.delete(serverId);
}

/** Run `fn` holding the server's lifecycle lock; throws ServerBusyError when
 *  another operation holds it. */
export async function withServerLifecycle<T>(
  serverId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!tryAcquireServerLifecycle(serverId)) throw new ServerBusyError(serverId);
  try {
    return await fn();
  } finally {
    releaseServerLifecycle(serverId);
  }
}

/** Test-only: clear held locks (Bun leaks module state across files). */
export function __resetServerLifecycleForTests(): void {
  held.clear();
}
