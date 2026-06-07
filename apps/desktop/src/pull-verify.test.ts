import { describe, expect, mock, test } from "bun:test";

import type { CosignSignatureMaterial } from "./cosign-verify";
import {
  pullAndVerify,
  PullPhaseError,
  type PullAndVerifyDeps,
} from "./pull-verify";

const FAKE_SIG: CosignSignatureMaterial = {
  digest: "sha256:" + "a".repeat(64),
  payloadJson: '{"critical":{"image":{"docker-manifest-digest":"sha256:..."}}}',
  signatureB64: "MEUCIQ==",
};

const IMAGE = "ghcr.io/uncorded/runtime:0.1.0-dev.1";

interface Recorder {
  pulled: string[];
  verified: string[];
  pullCompleteCalls: number;
}

function makeDeps(
  recorder: Recorder,
  overrides: Partial<PullAndVerifyDeps> = {},
): PullAndVerifyDeps {
  return {
    pullImage: async (image: string, _onProgress: (line: string) => void) => {
      recorder.pulled.push(image);
    },
    verifyAndExtract: async (image: string) => {
      recorder.verified.push(image);
      return FAKE_SIG;
    },
    onPullComplete: () => {
      recorder.pullCompleteCalls += 1;
    },
    ...overrides,
  };
}

function newRecorder(): Recorder {
  return { pulled: [], verified: [], pullCompleteCalls: 0 };
}

describe("pullAndVerify — happy path", () => {
  test("pulls then verifies and returns the verified digest + signature", async () => {
    const rec = newRecorder();
    const deps = makeDeps(rec);

    const result = await pullAndVerify({ sourceImage: IMAGE }, deps);

    expect(rec.pulled).toEqual([IMAGE]);
    expect(rec.verified).toEqual([IMAGE]);
    expect(result.digest).toBe(FAKE_SIG.digest);
    expect(result.signature).toBe(FAKE_SIG);
  });

  test("invokes onPullComplete after pull but before verify", async () => {
    const rec = newRecorder();
    const order: string[] = [];
    const deps = makeDeps(rec, {
      pullImage: async (image: string) => {
        order.push("pull:" + image);
        rec.pulled.push(image);
      },
      onPullComplete: () => {
        order.push("onPullComplete");
        rec.pullCompleteCalls += 1;
      },
      verifyAndExtract: async (image: string) => {
        order.push("verify:" + image);
        rec.verified.push(image);
        return FAKE_SIG;
      },
    });

    await pullAndVerify({ sourceImage: IMAGE }, deps);

    expect(order).toEqual([`pull:${IMAGE}`, "onPullComplete", `verify:${IMAGE}`]);
    expect(rec.pullCompleteCalls).toBe(1);
  });

  test("forwards pull progress lines to the caller", async () => {
    const rec = newRecorder();
    const lines: string[] = [];
    const deps = makeDeps(rec, {
      pullImage: async (image: string, onProgress: (line: string) => void) => {
        rec.pulled.push(image);
        onProgress("Pulling fs layer");
        onProgress("Downloading [==>] 12.34MB/45.67MB");
        onProgress("Pull complete");
      },
    });

    await pullAndVerify(
      { sourceImage: IMAGE, onPullProgress: (line) => lines.push(line) },
      deps,
    );

    expect(lines).toEqual([
      "Pulling fs layer",
      "Downloading [==>] 12.34MB/45.67MB",
      "Pull complete",
    ]);
  });

  test("logs verified digest at info when log adapter provided", async () => {
    const rec = newRecorder();
    const info = mock();
    const deps = makeDeps(rec, { log: { info, warn: mock() } });

    await pullAndVerify({ sourceImage: IMAGE }, deps);

    expect(info).toHaveBeenCalledWith(
      "signature verified",
      expect.objectContaining({ image: IMAGE, digest: FAKE_SIG.digest }),
    );
  });
});

describe("pullAndVerify — failure modes", () => {
  test("pull failure throws PullPhaseError with the underlying cause and skips verify", async () => {
    const rec = newRecorder();
    const cause = new Error("registry unreachable");
    const deps = makeDeps(rec, {
      pullImage: async () => {
        throw cause;
      },
    });

    let thrown: unknown;
    try {
      await pullAndVerify({ sourceImage: IMAGE }, deps);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PullPhaseError);
    if (!(thrown instanceof PullPhaseError)) return;
    expect(thrown.message).toBe("registry unreachable");
    expect(thrown.cause).toBe(cause);
    expect(thrown.name).toBe("PullPhaseError");

    // Critical: verify must NOT run if pull failed.
    expect(rec.verified).toEqual([]);
    // onPullComplete must NOT fire on pull failure.
    expect(rec.pullCompleteCalls).toBe(0);
  });

  test("pull failure with non-Error rejection still produces a PullPhaseError", async () => {
    const rec = newRecorder();
    const deps = makeDeps(rec, {
      pullImage: async () => {
        // eslint-disable-next-line no-throw-literal
        throw "string failure";
      },
    });

    let thrown: unknown;
    try {
      await pullAndVerify({ sourceImage: IMAGE }, deps);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PullPhaseError);
    if (!(thrown instanceof PullPhaseError)) return;
    expect(thrown.message).toBe("string failure");
    expect(thrown.cause).toBe("string failure");
  });

  test("verify failure bubbles unchanged (not wrapped in PullPhaseError)", async () => {
    const rec = newRecorder();
    const cause = new Error("signature_unavailable");
    const deps = makeDeps(rec, {
      verifyAndExtract: async () => {
        throw cause;
      },
    });

    let thrown: unknown;
    try {
      await pullAndVerify({ sourceImage: IMAGE }, deps);
    } catch (err) {
      thrown = err;
    }

    // Caller discriminates pull vs verify via instanceof — verify errors
    // must NOT be PullPhaseError, otherwise the operator copy is wrong.
    expect(thrown).toBe(cause);
    expect(thrown).not.toBeInstanceOf(PullPhaseError);

    // Pull ran and onPullComplete fired before verify failed.
    expect(rec.pulled).toEqual([IMAGE]);
    expect(rec.pullCompleteCalls).toBe(1);
  });
});

describe("pullAndVerify — skipVerify (pre-first-release seed)", () => {
  test("skips verify when skipVerify=true and returns empty digest + undefined signature", async () => {
    const rec = newRecorder();
    const warn = mock();
    const deps = makeDeps(rec, { log: { info: mock(), warn } });

    const result = await pullAndVerify(
      { sourceImage: IMAGE, skipVerify: true },
      deps,
    );

    expect(rec.pulled).toEqual([IMAGE]);
    expect(rec.verified).toEqual([]);
    expect(result.digest).toBe("");
    expect(result.signature).toBeUndefined();

    // onPullComplete still fires (the operator pill should still flip).
    expect(rec.pullCompleteCalls).toBe(1);

    // Warn line is emitted so seed-state operation is visible in logs.
    expect(warn).toHaveBeenCalledWith(
      "cosign verification skipped (no embedded pubkey)",
      expect.objectContaining({ image: IMAGE }),
    );
  });

  test("skipVerify=false (or unset) goes through verify normally", async () => {
    const rec = newRecorder();
    const deps = makeDeps(rec);

    const result = await pullAndVerify(
      { sourceImage: IMAGE, skipVerify: false },
      deps,
    );

    expect(rec.verified).toEqual([IMAGE]);
    expect(result.signature).toBe(FAKE_SIG);
  });
});

describe("pullAndVerify — onPullComplete contract", () => {
  test("awaits onPullComplete before starting verify", async () => {
    const rec = newRecorder();
    const order: string[] = [];
    let pullCompleteResolve!: () => void;
    const pullCompletePromise = new Promise<void>((res) => {
      pullCompleteResolve = res;
    });

    const deps = makeDeps(rec, {
      onPullComplete: async () => {
        order.push("onPullComplete:start");
        await pullCompletePromise;
        order.push("onPullComplete:end");
        rec.pullCompleteCalls += 1;
      },
      verifyAndExtract: async (image: string) => {
        order.push("verify:" + image);
        rec.verified.push(image);
        return FAKE_SIG;
      },
    });

    const promise = pullAndVerify({ sourceImage: IMAGE }, deps);

    // Let microtasks flush so onPullComplete has started but is paused.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["onPullComplete:start"]);

    pullCompleteResolve();
    await promise;

    expect(order).toEqual([
      "onPullComplete:start",
      "onPullComplete:end",
      `verify:${IMAGE}`,
    ]);
  });

  test("works fine when onPullComplete is omitted", async () => {
    const rec = newRecorder();
    const deps: PullAndVerifyDeps = {
      pullImage: async (image: string) => {
        rec.pulled.push(image);
      },
      verifyAndExtract: async (image: string) => {
        rec.verified.push(image);
        return FAKE_SIG;
      },
    };

    const result = await pullAndVerify({ sourceImage: IMAGE }, deps);

    expect(result.signature).toBe(FAKE_SIG);
    expect(rec.pulled).toEqual([IMAGE]);
    expect(rec.verified).toEqual([IMAGE]);
  });
});
