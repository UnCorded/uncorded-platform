import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ChildProcess, ExecFileOptions } from "child_process";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import * as _realChildProcess from "child_process";
// Snapshot real exports by value so afterAll can restore the genuine module
// shape. `import * as` is a live binding — reading from it after the mock
// applies would just return the stubbed shape (matching the pattern
// established in cloudflared-cli.test.ts).
const realChildProcess = { ..._realChildProcess };

// Capture the real ./cosign-bin surface before we stub it below. Bun's
// mock.module is process-global and leaks across files on Linux CI, so without
// restoring it in afterAll the stub bleeds into cosign-bin.test.ts.
import * as _realCosignBin from "./cosign-bin";
const realCosignBin = { ..._realCosignBin };

const mockExecFile = mock<typeof import("child_process").execFile>();

let cosignVerifyModule: typeof import("./cosign-verify");

// Generate a real Ed25519 keypair for the test run. We don't actually exercise
// the verification crypto here (cosign is shelled out + mocked), but we use
// the keypair to construct realistic fake signatures + payloads in the
// mocked subprocess responses.
const KEYPAIR = (() => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pubPem: publicKey.export({ format: "pem", type: "spki" }) as string,
    privPem: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
  };
})();

const DIGEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const IMAGE_REF = "ghcr.io/uncorded/runtime:0.1.0";

interface ExecCall {
  file: string;
  args: string[];
  options: ExecFileOptions;
}

let execCalls: ExecCall[] = [];

/**
 * Queue ordered subprocess responses. Each call to `mockExecFile` consumes the
 * next entry; the order is what callers expect from
 * `verifyAndExtractMaterial` (verify → docker inspect → download signature).
 */
function queueExecResponses(
  responses: Array<
    | { ok: true; stdout?: string; stderr?: string }
    | {
        ok: false;
        message?: string;
        code?: string | number;
        killed?: boolean;
        signal?: NodeJS.Signals | null;
        stderr?: string;
      }
  >,
): void {
  let index = 0;
  mockExecFile.mockImplementation(((...args: unknown[]) => {
    const file = args[0] as string;
    const cliArgs = args[1] as string[];
    const options = args[2] as ExecFileOptions;
    const callback = args[3] as (
      error: NodeJS.ErrnoException | null,
      stdout: string,
      stderr: string,
    ) => void;
    execCalls.push({ file, args: cliArgs, options });

    const response = responses[index++];
    if (!response) {
      const error = Object.assign(
        new Error("Unexpected execFile call (no response queued)"),
        { code: 1 },
      );
      callback(error as unknown as NodeJS.ErrnoException, "", "no response queued");
      return {} as ChildProcess;
    }
    if (response.ok) {
      callback(null, response.stdout ?? "", response.stderr ?? "");
    } else {
      // execFile callbacks receive a numeric exit code in `error.code` for
      // non-zero exits and the string "ENOENT" when the binary is missing.
      // NodeJS.ErrnoException only types `code` as string|undefined, so we
      // cast through unknown — this matches the cloudflared-cli.test.ts
      // pattern (production code already handles both shapes).
      const error = Object.assign(new Error(response.message ?? "exec failed"), {
        code: response.code,
        killed: response.killed,
        signal: response.signal ?? null,
        stderr: response.stderr ?? "",
      });
      callback(error as unknown as NodeJS.ErrnoException, "", response.stderr ?? "");
    }
    return {} as ChildProcess;
  }) as unknown as typeof import("child_process").execFile);
}

function makePayload(args?: { digest?: string; reference?: string; type?: string }): string {
  return JSON.stringify({
    critical: {
      identity: { "docker-reference": args?.reference ?? "ghcr.io/uncorded/runtime" },
      image: { "docker-manifest-digest": args?.digest ?? DIGEST },
      type: args?.type ?? "cosign container image signature",
    },
    optional: { creator: "test" },
  });
}

function signPayload(payloadJson: string): string {
  const { createPrivateKey } = require("node:crypto");
  const key = createPrivateKey({ key: KEYPAIR.privPem, format: "pem" });
  return cryptoSign(null, Buffer.from(payloadJson, "utf8"), key).toString("base64");
}

function dockerInspectResponse(digest: string = DIGEST): string {
  return JSON.stringify([`ghcr.io/uncorded/runtime@${digest}`]) + "\n";
}

function cosignDownloadResponse(rows: Array<{ payload: string; signature: string }>): string {
  return rows
    .map((row) =>
      JSON.stringify({
        Base64Signature: row.signature,
        Payload: Buffer.from(row.payload, "utf8").toString("base64"),
        Cert: null,
        Chain: null,
      }),
    )
    .join("\n");
}

beforeAll(async () => {
  // Spread real exports so siblings that need spawn/exec/fork still resolve.
  await mock.module("child_process", () => ({
    ...realChildProcess,
    execFile: mockExecFile,
  }));

  // cosign-verify imports cosign-bin to resolve the binary; in tests we just
  // hand back a fixed path so verify logic doesn't need a real bundled exe.
  await mock.module("./cosign-bin", () => ({
    CosignBinaryNotFoundError: class CosignBinaryNotFoundError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "CosignBinaryNotFoundError";
      }
    },
    getBundledCosignBinary: () => (process.platform === "win32" ? "cosign.exe" : "cosign"),
  }));

  cosignVerifyModule = await import("./cosign-verify");
});

beforeEach(() => {
  mockExecFile.mockReset();
  execCalls = [];
});

afterEach(() => {
  // No persistent state between tests beyond the module mock.
});

afterAll(async () => {
  await mock.module("child_process", () => realChildProcess);
  await mock.module("./cosign-bin", () => realCosignBin);
});

describe("verifyImage", () => {
  it("invokes cosign verify with the correct args and returns the parsed JSON", async () => {
    const verifyOutput = JSON.stringify([
      {
        critical: {
          identity: { "docker-reference": "ghcr.io/uncorded/runtime" },
          image: { "docker-manifest-digest": DIGEST },
          type: "cosign container image signature",
        },
      },
    ]);
    queueExecResponses([{ ok: true, stdout: verifyOutput }]);

    const result = await cosignVerifyModule.verifyImage({
      imageRef: IMAGE_REF,
      pubkeyPem: KEYPAIR.pubPem,
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);

    expect(execCalls).toHaveLength(1);
    const call = execCalls[0]!;
    expect(call.args[0]).toBe("verify");
    expect(call.args[1]).toBe("--key");
    expect(typeof call.args[2]).toBe("string");
    expect(call.args[2]!.length).toBeGreaterThan(0); // tempfile path
    expect(call.args[3]).toBe("--output");
    expect(call.args[4]).toBe("json");
    expect(call.args[5]).toBe(IMAGE_REF);
  });

  it("throws pubkey_not_embedded when the PEM is empty", async () => {
    await expect(
      cosignVerifyModule.verifyImage({ imageRef: IMAGE_REF, pubkeyPem: "" }),
    ).rejects.toMatchObject({ code: "pubkey_not_embedded" });
    // No subprocess call should have happened — we fail before materializing.
    expect(execCalls).toHaveLength(0);
  });

  it("throws binary_not_found when cosign is missing", async () => {
    queueExecResponses([{ ok: false, code: "ENOENT", message: "spawn cosign ENOENT" }]);

    await expect(
      cosignVerifyModule.verifyImage({ imageRef: IMAGE_REF, pubkeyPem: KEYPAIR.pubPem }),
    ).rejects.toMatchObject({ code: "binary_not_found" });
  });

  it("relabels 'no signatures found' as no_signature", async () => {
    queueExecResponses([
      {
        ok: false,
        code: 1,
        message: "exit 1",
        stderr: "Error: no signatures found for ghcr.io/uncorded/runtime:0.1.0",
      },
    ]);

    await expect(
      cosignVerifyModule.verifyImage({ imageRef: IMAGE_REF, pubkeyPem: KEYPAIR.pubPem }),
    ).rejects.toMatchObject({ code: "no_signature" });
  });

  it("relabels other non-zero exits as verify_failed", async () => {
    queueExecResponses([
      {
        ok: false,
        code: 1,
        message: "exit 1",
        stderr: "Error: signature does not verify against the supplied key",
      },
    ]);

    await expect(
      cosignVerifyModule.verifyImage({ imageRef: IMAGE_REF, pubkeyPem: KEYPAIR.pubPem }),
    ).rejects.toMatchObject({ code: "verify_failed" });
  });

  it("rejects when cosign produces invalid JSON", async () => {
    queueExecResponses([{ ok: true, stdout: "{not json" }]);

    await expect(
      cosignVerifyModule.verifyImage({ imageRef: IMAGE_REF, pubkeyPem: KEYPAIR.pubPem }),
    ).rejects.toMatchObject({ code: "verify_failed" });
  });
});

describe("getImageDigest", () => {
  it("returns the sha256 digest from RepoDigests[0]", async () => {
    queueExecResponses([{ ok: true, stdout: dockerInspectResponse(DIGEST) }]);

    const digest = await cosignVerifyModule.getImageDigest(IMAGE_REF);
    expect(digest).toBe(DIGEST);
  });

  it("scans past entries that lack a sha256 prefix", async () => {
    const stdout =
      JSON.stringify([
        "ghcr.io/uncorded/runtime@notadigest",
        `ghcr.io/uncorded/runtime@${DIGEST}`,
      ]) + "\n";
    queueExecResponses([{ ok: true, stdout }]);

    const digest = await cosignVerifyModule.getImageDigest(IMAGE_REF);
    expect(digest).toBe(DIGEST);
  });

  it("throws digest_unavailable when RepoDigests is empty (image was never pulled)", async () => {
    queueExecResponses([{ ok: true, stdout: "[]\n" }]);

    await expect(cosignVerifyModule.getImageDigest(IMAGE_REF)).rejects.toMatchObject({
      code: "digest_unavailable",
    });
  });

  it("throws digest_unavailable when docker inspect fails", async () => {
    queueExecResponses([
      {
        ok: false,
        code: 1,
        message: "exit 1",
        stderr: "Error: No such image: ghcr.io/uncorded/runtime:0.1.0",
      },
    ]);

    await expect(cosignVerifyModule.getImageDigest(IMAGE_REF)).rejects.toMatchObject({
      code: "digest_unavailable",
    });
  });
});

describe("getSignatureMaterial", () => {
  it("returns the row whose payload matches the expected digest", async () => {
    const payload = makePayload();
    const signature = signPayload(payload);
    queueExecResponses([
      { ok: true, stdout: cosignDownloadResponse([{ payload, signature }]) },
    ]);

    const material = await cosignVerifyModule.getSignatureMaterial({
      imageRef: IMAGE_REF,
      expectedDigest: DIGEST,
    });

    expect(material.digest).toBe(DIGEST);
    expect(material.payloadJson).toBe(payload);
    expect(material.signatureB64).toBe(signature);
  });

  it("skips rows whose payload is for a different digest", async () => {
    const stalePayload = makePayload({
      digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999",
    });
    const honestPayload = makePayload();
    queueExecResponses([
      {
        ok: true,
        stdout: cosignDownloadResponse([
          { payload: stalePayload, signature: signPayload(stalePayload) },
          { payload: honestPayload, signature: signPayload(honestPayload) },
        ]),
      },
    ]);

    const material = await cosignVerifyModule.getSignatureMaterial({
      imageRef: IMAGE_REF,
      expectedDigest: DIGEST,
    });

    expect(material.payloadJson).toBe(honestPayload);
  });

  it("throws no_signature when cosign reports no signatures attached", async () => {
    queueExecResponses([
      {
        ok: false,
        code: 1,
        message: "exit 1",
        stderr: "Error: no signatures found for image",
      },
    ]);

    await expect(
      cosignVerifyModule.getSignatureMaterial({
        imageRef: IMAGE_REF,
        expectedDigest: DIGEST,
      }),
    ).rejects.toMatchObject({ code: "no_signature" });
  });

  it("throws signature_unavailable when no row matches the expected digest", async () => {
    const stalePayload = makePayload({
      digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999",
    });
    queueExecResponses([
      {
        ok: true,
        stdout: cosignDownloadResponse([
          { payload: stalePayload, signature: signPayload(stalePayload) },
        ]),
      },
    ]);

    await expect(
      cosignVerifyModule.getSignatureMaterial({
        imageRef: IMAGE_REF,
        expectedDigest: DIGEST,
      }),
    ).rejects.toMatchObject({ code: "signature_unavailable" });
  });

  it("throws no_signature when cosign returns empty stdout", async () => {
    queueExecResponses([{ ok: true, stdout: "" }]);

    await expect(
      cosignVerifyModule.getSignatureMaterial({
        imageRef: IMAGE_REF,
        expectedDigest: DIGEST,
      }),
    ).rejects.toMatchObject({ code: "no_signature" });
  });
});

describe("verifyAndExtractMaterial", () => {
  it("runs verify → inspect → download in order and returns the material bundle", async () => {
    const payload = makePayload();
    const signature = signPayload(payload);
    queueExecResponses([
      // 1) cosign verify
      {
        ok: true,
        stdout: JSON.stringify([
          {
            critical: {
              identity: { "docker-reference": "ghcr.io/uncorded/runtime" },
              image: { "docker-manifest-digest": DIGEST },
              type: "cosign container image signature",
            },
          },
        ]),
      },
      // 2) docker inspect
      { ok: true, stdout: dockerInspectResponse(DIGEST) },
      // 3) cosign download signature
      { ok: true, stdout: cosignDownloadResponse([{ payload, signature }]) },
    ]);

    const material = await cosignVerifyModule.verifyAndExtractMaterial({
      imageRef: IMAGE_REF,
      pubkeyPem: KEYPAIR.pubPem,
    });

    expect(material).toEqual({
      digest: DIGEST,
      payloadJson: payload,
      signatureB64: signature,
    });

    expect(execCalls).toHaveLength(3);
    expect(execCalls[0]!.args[0]).toBe("verify");
    expect(execCalls[1]!.args[0]).toBe("image"); // docker image inspect
    expect(execCalls[1]!.args[1]).toBe("inspect");
    expect(execCalls[2]!.args[0]).toBe("download");
    expect(execCalls[2]!.args[1]).toBe("signature");
  });

  it("aborts before docker inspect when verify fails (defensive ordering)", async () => {
    queueExecResponses([
      {
        ok: false,
        code: 1,
        message: "exit 1",
        stderr: "Error: signature does not verify against the supplied key",
      },
    ]);

    await expect(
      cosignVerifyModule.verifyAndExtractMaterial({
        imageRef: IMAGE_REF,
        pubkeyPem: KEYPAIR.pubPem,
      }),
    ).rejects.toMatchObject({ code: "verify_failed" });

    // Critical: only the verify call should have run. We must NOT reach
    // docker inspect for an image whose signature failed.
    expect(execCalls).toHaveLength(1);
  });
});
