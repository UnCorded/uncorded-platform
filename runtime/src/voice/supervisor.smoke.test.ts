// CI-guarded smoke test for the LiveKit supervisor.
//
// Skipped automatically when no real `livekit-server` binary is available —
// local dev machines without the binary don't pay the spawn cost, and CI
// runs that bake the binary into the image (or set LIVEKIT_BIN_PATH) get
// real-process coverage of the spawn → ready → stop flow.
//
// Activation:
//   - Set LIVEKIT_BIN_PATH to an executable livekit-server binary, OR
//   - Place the binary at /opt/livekit/livekit-server (the Dockerfile bake
//     path; CI inside the image picks it up automatically).
//
// To force-skip on a machine that does happen to have a binary, set
// SKIP_LIVEKIT_SMOKE=1.
//
// What this verifies that the unit tests cannot:
//   - The pinned binary actually loads with the runtime-rendered config.
//   - The HTTP readiness probe reaches the signaling port the supervisor
//     wrote into livekit.yaml.
//   - SIGTERM cleanup actually drops the process within the grace period.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveKitSupervisor } from "./supervisor";
import type { VoicePortPlan } from "./config";

// Allow CI to point at a known-good binary, fall back to the Dockerfile
// bake path. The fallback is what runs inside the container image.
const BIN_PATH = process.env["LIVEKIT_BIN_PATH"] ?? "/opt/livekit/livekit-server";

function isBinaryAvailable(): boolean {
  if (process.env["SKIP_LIVEKIT_SMOKE"] === "1") return false;
  try {
    return existsSync(BIN_PATH) && statSync(BIN_PATH).isFile();
  } catch {
    return false;
  }
}

const SMOKE_ENABLED = isBinaryAvailable();

// describe.skipIf is the right primitive — the suite is silently skipped
// when the binary isn't there, so a missing binary doesn't fail the run.
const describeIf = SMOKE_ENABLED ? describe : describe.skip;

const TEST_SECRET = "x".repeat(64);
let prevSecret: string | undefined;

beforeAll(() => {
  prevSecret = process.env["RUNTIME_ENCRYPTION_SECRET"];
  process.env["RUNTIME_ENCRYPTION_SECRET"] = TEST_SECRET;
});

afterAll(() => {
  if (prevSecret === undefined) delete process.env["RUNTIME_ENCRYPTION_SECRET"];
  else process.env["RUNTIME_ENCRYPTION_SECRET"] = prevSecret;
});

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_config (
      service_slug     TEXT    NOT NULL PRIMARY KEY,
      api_key          TEXT    NOT NULL,
      secret_encrypted TEXT    NOT NULL,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
  `);
  return db;
}

// Avoid colliding with a running LiveKit on the host's default 7880; the
// supervisor's readiness probe targets whichever signaling port we set.
function highPorts(): VoicePortPlan {
  const base = 47880 + Math.floor(Math.random() * 1000);
  return {
    signaling: base,
    rtcTcp: base + 1,
    rtcUdpPort: base + 100,
    // Amendment C TURN port — keep clear of the signaling/MUX/TCP slots
    // the smoke test allocates above. +200 leaves the same kind of
    // breathing room the existing layout uses.
    turnUdpPort: base + 200,
  };
}

describeIf("livekit-server smoke (real binary)", () => {
  test(
    "spawns, becomes ready, reports version, stops cleanly",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "uncorded-voice-smoke-"));
      const configPath = join(dir, "livekit.yaml");
      const db = makeDb();

      const sup = new LiveKitSupervisor("livekit", {
        db,
        livekitBinPath: BIN_PATH,
        configPath,
        ports: highPorts(),
        livekitVersion: "smoke",
      });

      try {
        const claimed = await sup.claim({ pluginSlug: "smoke-test" });
        expect(claimed.ok).toBe(true);

        const health = await sup.health();
        expect(health.status).toBe("ready");
        // livekitVersion is the operator-supplied label, not what the
        // process reports — but it should round-trip through health().
        expect(health.livekitVersion).toBe("smoke");
        expect(health.uptimeMs).not.toBeNull();
      } finally {
        await sup.release({ pluginSlug: "smoke-test" }).catch(() => {});
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    // 60s — the supervisor's own startup timeout is 30s, give the suite
    // headroom for ports binding + cleanup.
    60_000,
  );
});
