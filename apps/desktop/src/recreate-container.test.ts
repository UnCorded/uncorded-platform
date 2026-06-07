import { describe, expect, mock, test } from "bun:test";

import type { CosignSignatureMaterial } from "./cosign-verify";
import {
  recreateContainerForServer,
  type RecreateContainerForServerArgs,
} from "./recreate-container";
import type { ServerRecord } from "./server-registry";

// The bug this file regression-tests: prior to 2026-05-10 the recreate
// adapter inside performUpdateForServer called runServerContainer directly,
// without first removing the stopped-but-still-present old container by
// id. `docker run --name uncorded-${slug}` then refused to start because
// the name was occupied, taking down both the install path AND the
// rollback path on every update attempt.

function fakeRecord(overrides: Partial<ServerRecord> = {}): ServerRecord {
  const base: ServerRecord = {
    containerId: "old-container-id",
    volumePath: "/v/uncorded-test-server-2",
    hostPort: 5101,
    backupBeforeUpdate: true,
  };
  return { ...base, ...overrides };
}

const FAKE_SIG: CosignSignatureMaterial = {
  digest: "sha256:" + "a".repeat(64),
  payloadJson: '{"critical":{"image":{"docker-manifest-digest":"sha256:..."}}}',
  signatureB64: "MEUCIQ==",
};

describe("recreateContainerForServer", () => {
  test("removes the old container by id BEFORE starting the new one", async () => {
    // The whole point of this adapter — prove the order is removeIfExists
    // → runServerContainer, not the other way around. The state machine
    // only stops the old container; if this adapter doesn't remove it,
    // docker rejects the new `docker run --name` with a name conflict and
    // both install + rollback fail (the production incident on 0.0.7).
    const calls: string[] = [];
    const removeIfExists = mock(async (id: string) => {
      calls.push(`removeIfExists(${id})`);
    });
    const runServerContainer = mock(async (args: { volumePath: string }) => {
      calls.push(`runServerContainer(${args.volumePath})`);
      return "new-container-id";
    });

    const args: RecreateContainerForServerArgs = {
      record: fakeRecord(),
      tunnelToken: "tunnel-tok",
      runtimeEncryptionSecret: "secret",
      signature: undefined,
    };
    const out = await recreateContainerForServer(args, {
      removeIfExists,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runServerContainer: runServerContainer as any,
    });

    expect(out).toBe("new-container-id");
    expect(calls).toEqual([
      "removeIfExists(old-container-id)",
      "runServerContainer(/v/uncorded-test-server-2)",
    ]);
  });

  test("forwards optional cosign signature material", async () => {
    const removeIfExists = mock(async () => {});
    let captured: { imageSignature?: CosignSignatureMaterial } | undefined;
    const runServerContainer = mock(async (a: { imageSignature?: CosignSignatureMaterial }) => {
      captured = a;
      return "id";
    });

    await recreateContainerForServer(
      {
        record: fakeRecord(),
        tunnelToken: undefined,
        runtimeEncryptionSecret: "secret",
        signature: FAKE_SIG,
      },
      {
        removeIfExists,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runServerContainer: runServerContainer as any,
      },
    );

    expect(captured?.imageSignature).toEqual(FAKE_SIG);
  });

  test("omits signature key entirely when none provided (seed-state behavior)", async () => {
    // During the seed period before the first signed runtime release the
    // pubkey is empty, the verify phase is skipped, and signature ends up
    // undefined. We must NOT spread `imageSignature: undefined` into the
    // call — server-runtime.ts treats the key's presence (even with
    // undefined value) differently from absence under exactOptionalPropertyTypes.
    const removeIfExists = mock(async () => {});
    let capturedKeys: string[] = [];
    const runServerContainer = mock(async (a: object) => {
      capturedKeys = Object.keys(a);
      return "id";
    });

    await recreateContainerForServer(
      {
        record: fakeRecord(),
        tunnelToken: "t",
        runtimeEncryptionSecret: "s",
        signature: undefined,
      },
      {
        removeIfExists,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runServerContainer: runServerContainer as any,
      },
    );

    expect(capturedKeys).not.toContain("imageSignature");
  });

  test("forwards optional tunnel + voice public hostnames when set on the record", async () => {
    const removeIfExists = mock(async () => {});
    let captured: { tunnelPublicHostname?: string; voicePublicHostname?: string } | undefined;
    const runServerContainer = mock(
      async (a: { tunnelPublicHostname?: string; voicePublicHostname?: string }) => {
        captured = a;
        return "id";
      },
    );

    await recreateContainerForServer(
      {
        record: fakeRecord({
          tunnelPublicHostname: "tunnel.example.com",
          voicePublicHostname: "voice.example.com",
        }),
        tunnelToken: "t",
        runtimeEncryptionSecret: "s",
        signature: undefined,
      },
      {
        removeIfExists,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runServerContainer: runServerContainer as any,
      },
    );

    expect(captured?.tunnelPublicHostname).toBe("tunnel.example.com");
    expect(captured?.voicePublicHostname).toBe("voice.example.com");
  });
});
