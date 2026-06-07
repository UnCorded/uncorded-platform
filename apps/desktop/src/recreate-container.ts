// Pure helper for the install/rollback "recreate the runtime container"
// step. Lives in its own file (rather than inside runtime-orchestrator.ts)
// so the unit test can import it without dragging electron's `app` into
// the bun-test runtime — the orchestrator transitively imports central.ts
// → electron.app, which crashes outside an Electron process.

import type { CosignSignatureMaterial } from "./cosign-verify";
import type { runServerContainer } from "./server-runtime";
import type { ServerRecord } from "./server-registry";

/** Args for the install/rollback recreate adapter. */
export interface RecreateContainerForServerArgs {
  record: ServerRecord;
  tunnelToken: string | undefined;
  runtimeEncryptionSecret: string;
  signature: CosignSignatureMaterial | undefined;
}

/** Injectable seam for the two production primitives the adapter needs. */
export interface RecreateContainerForServerDeps {
  removeIfExists: (containerId: string) => Promise<void>;
  runServerContainer: typeof runServerContainer;
}

/**
 * Force-remove the old container *by id*, then run a new one with the same
 * deterministic name (`uncorded-${basename(volumePath)}`).
 *
 * Order matters: `runServerContainer` does `docker run --name <name>` and
 * docker refuses to recreate a name that's already taken — even if the
 * occupant is in `Exited` state. The state machine in `runtime-update.ts`
 * only `stopContainer`s the old one; it never `removeContainer`s it because
 * it has no business owning the lifecycle decision. So this adapter is the
 * single seam where post-stop teardown happens (per the contract at
 * runtime-update.ts:84-86 — "Caller wraps removeIfExists + runServerContainer").
 *
 * Used by both the install path (after stop, before docker run) AND the
 * rollback path (where the same naming collision would otherwise re-fail
 * the recovery).
 */
export async function recreateContainerForServer(
  args: RecreateContainerForServerArgs,
  deps: RecreateContainerForServerDeps,
): Promise<string> {
  await deps.removeIfExists(args.record.containerId);
  return deps.runServerContainer({
    volumePath: args.record.volumePath,
    hostPort: args.record.hostPort,
    tunnelToken: args.tunnelToken,
    runtimeEncryptionSecret: args.runtimeEncryptionSecret,
    ...(args.record.tunnelPublicHostname
      ? { tunnelPublicHostname: args.record.tunnelPublicHostname }
      : {}),
    ...(args.record.voicePublicHostname
      ? { voicePublicHostname: args.record.voicePublicHostname }
      : {}),
    ...(args.signature ? { imageSignature: args.signature } : {}),
  });
}
