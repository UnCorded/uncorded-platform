import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveCanPublishSources } from "../backend/voice-join";

// PR-6 §14 — trust-boundary tests. The plugin `voice.join` handler is the
// single authorization point in the chain; everything downstream (runtime IPC,
// JWT mint, LiveKit SFU) only validates shape or signs the claim. These
// tests lock in the four cases the plan calls out:
//
//   1. user with permission gets full sources (mic + screen + screen_audio)
//   2. user without permission gets ["microphone"]
//   3. e2ee channel returns ["microphone"] regardless of permission
//   4. client-provided `canPublishSources` field on params is dropped
//
// Cases 1-3 are exercised by `deriveCanPublishSources`. Case 4 is a static
// invariant of the call site: by construction the helper takes no `params`
// argument, so no client-supplied field can reach it. The static probe at
// the bottom of this file asserts that the handler in index.ts continues
// to honor that invariant — i.e. there's no `params["canPublishSources"]`
// reference anywhere in the file.

describe("deriveCanPublishSources — permission gate", () => {
  test("user with permission on plain channel gets full sources", () => {
    expect(
      deriveCanPublishSources({
        channelE2ee: false,
        hasShareScreenPermission: true,
      }),
    ).toEqual(["microphone", "screen_share", "screen_share_audio"]);
  });

  test("user without permission gets microphone-only", () => {
    expect(
      deriveCanPublishSources({
        channelE2ee: false,
        hasShareScreenPermission: false,
      }),
    ).toEqual(["microphone"]);
  });
});

describe("deriveCanPublishSources — e2ee channels (PR-6 §15)", () => {
  test("e2ee channel returns microphone-only even when user has permission", () => {
    expect(
      deriveCanPublishSources({
        channelE2ee: true,
        hasShareScreenPermission: true,
      }),
    ).toEqual(["microphone"]);
  });

  test("e2ee channel + no permission still returns microphone-only (no contradiction)", () => {
    expect(
      deriveCanPublishSources({
        channelE2ee: true,
        hasShareScreenPermission: false,
      }),
    ).toEqual(["microphone"]);
  });
});

describe("deriveCanPublishSources — output stability", () => {
  test("never grants camera (PR-6 ships screen content only)", () => {
    const cases: Array<{ channelE2ee: boolean; hasShareScreenPermission: boolean }> = [
      { channelE2ee: false, hasShareScreenPermission: true },
      { channelE2ee: false, hasShareScreenPermission: false },
      { channelE2ee: true, hasShareScreenPermission: true },
      { channelE2ee: true, hasShareScreenPermission: false },
    ];
    for (const c of cases) {
      const result = deriveCanPublishSources(c);
      expect(result).not.toContain("camera");
      // Microphone must always be present so audio-only joins work even
      // when screen-share is gated.
      expect(result).toContain("microphone");
    }
  });

  test("returned arrays are independent (no shared mutable state)", () => {
    const a = deriveCanPublishSources({
      channelE2ee: false,
      hasShareScreenPermission: true,
    });
    const b = deriveCanPublishSources({
      channelE2ee: false,
      hasShareScreenPermission: true,
    });
    expect(a).not.toBe(b);
    a.push("camera");
    expect(b).toEqual([
      "microphone",
      "screen_share",
      "screen_share_audio",
    ]);
  });
});

describe("voice.join handler — client-provided canPublishSources is dropped", () => {
  // The plugin handler must never consult `params["canPublishSources"]`. Since
  // the derivation is delegated to a pure helper that takes no params, the
  // only way the handler could leak client trust would be if it referenced
  // that field directly. Static probe of the source file asserts it doesn't.
  // Mirrors the existing `grants` drop precedent (defense-in-depth).

  test("backend/index.ts does not read params['canPublishSources']", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const indexPath = resolve(here, "..", "backend", "index.ts");
    const src = readFileSync(indexPath, "utf8");
    // Any of the common access patterns counts as a violation.
    expect(src).not.toContain('params["canPublishSources"]');
    expect(src).not.toContain("params['canPublishSources']");
    expect(src).not.toContain("params.canPublishSources");
  });
});
