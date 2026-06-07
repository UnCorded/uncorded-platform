// Desktop-side registry ↔ Central reconciliation. Extracted from main.ts so
// it's testable without booting Electron. main.ts constructs a closure with
// the real dependencies; tests pass doubles. Keep this file free of
// `import from "electron"` so bun test can load it directly.

export interface ReconcileDeps {
  /** Fetch remote servers from Central. Must throw / reject on network or HTTP
   *  failure — reconcile treats any rejection as "skip this run". */
  listRemoteServers: () => Promise<unknown>;
  /** Enumerate local registry records. */
  listLocalRecords: () => Array<{ serverId: string; record: unknown }>;
  /** True if the registry was quarantined this session. Reconcile is a no-op
   *  in that case — we'd be reconciling an empty registry against Central
   *  and the user's real state is frozen in the quarantine file, not here. */
  wasQuarantinedThisSession: () => boolean;
  /** Tear down a single orphaned server locally: stop + remove container,
   *  delete volume, drop keychain entry, remove from registry. Must be safe
   *  to call when state is partially missing (best-effort). */
  purgeLocalServer: (serverId: string) => Promise<void>;
  /** Structured logger. */
  log: {
    info: (message: string, ctx?: Record<string, unknown>) => void;
    warn: (message: string, ctx?: Record<string, unknown>) => void;
    error: (message: string, ctx?: Record<string, unknown>) => void;
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * On launch, before restoreServerContainers: ask Central which servers this
 * user still owns, and for any local registry entry Central doesn't know
 * about, tear down the container + volume + tunnel token via purgeLocalServer.
 *
 * Safety guards (in order):
 *   1. Quarantined this session → skip entirely. The registry is blank; the
 *      banner surfaces the issue to the user.
 *   2. Central call throws → skip. Offline boot is a normal flow; wiping the
 *      user's servers because Central was unreachable would be a footgun.
 *   3. Response isn't an array → skip. Defensive against an API shape change
 *      without coordinated client updates.
 *   4. Central returns empty list AND we have >= 2 local records → skip,
 *      treating as a bogus response. A single-entry mismatch is fine to
 *      reconcile (the user actually deleted their one server); but "all your
 *      servers vanished" is almost certainly a signal error, not reality.
 */
export async function reconcileRegistryWithCentral(deps: ReconcileDeps): Promise<void> {
  const { listRemoteServers, listLocalRecords, wasQuarantinedThisSession, purgeLocalServer, log } = deps;

  if (wasQuarantinedThisSession()) {
    log.info("reconcile skipped — post-quarantine startup");
    return;
  }

  let remote: unknown;
  try {
    remote = await listRemoteServers();
  } catch (err) {
    log.warn("reconcile skipped — central unreachable", { err: errorMessage(err) });
    return;
  }

  if (!Array.isArray(remote)) {
    log.warn("reconcile skipped — unexpected listServers response shape");
    return;
  }

  const remoteIds = new Set<string>();
  for (const entry of remote) {
    if (typeof entry === "object" && entry !== null && "id" in entry) {
      const id = (entry as { id: unknown }).id;
      if (typeof id === "string") remoteIds.add(id);
    }
  }

  const localRecords = listLocalRecords();
  const orphans = localRecords.filter(({ serverId }) => !remoteIds.has(serverId));
  if (orphans.length === 0) return;

  if (remoteIds.size === 0 && localRecords.length >= 2) {
    log.warn("reconcile bailed — central returned empty list against >=2 local records", {
      local: localRecords.length,
    });
    return;
  }

  log.info("reconciling registry — removing orphans", { count: orphans.length });
  for (const { serverId } of orphans) {
    try {
      await purgeLocalServer(serverId);
      log.info("reconcile purged orphan server", { serverId });
    } catch (err) {
      log.error("purgeLocalServer failed during reconcile", {
        serverId,
        err: errorMessage(err),
      });
    }
  }
}
