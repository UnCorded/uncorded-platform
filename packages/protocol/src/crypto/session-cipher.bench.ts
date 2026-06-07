// Throughput + latency benchmarks for the per-session cipher (PR-T4).
//
// Gated by `BENCH=1` because the throughput loops add seconds to a `bun
// test` run and we don't want them in CI green. Run locally with:
//
//   BENCH=1 bun test ./packages/protocol/src/crypto/session-cipher.bench.ts
//
// Budgets (from the PR-T4 plan):
//   - encryptFrame(4KB): ≥ 50 MB/s sustained
//   - decryptFrame(4KB): ≥ 30 MB/s sustained
//   - deriveSessionKey: < 5 ms p95 one-shot

import { describe, test } from "bun:test";
import {
  DIRECTION_ATTACH_TO_HOST,
  DIRECTION_HOST_TO_ATTACH,
  decryptFrame,
  deriveSessionKey,
  encryptFrame,
  generateAttachKeypair,
  generateHostKeypair,
  generateSessionRandom,
  importHostPrivateKey,
} from "./session-cipher.js";

const BENCH = process.env.BENCH === "1";

const PAYLOAD_BYTES = 4096;
const TARGET_MS = 1500;

interface ThroughputResult {
  ops: number;
  durationMs: number;
  opsPerSec: number;
  mbPerSec: number;
}

async function measureThroughput(
  label: string,
  payloadBytes: number,
  step: () => Promise<unknown>,
): Promise<ThroughputResult> {
  // Warmup so JIT + WebCrypto setup costs aren't billed to ops/sec.
  for (let i = 0; i < 50; i++) await step();
  const start = performance.now();
  let ops = 0;
  while (performance.now() - start < TARGET_MS) {
    await step();
    ops++;
  }
  const durationMs = performance.now() - start;
  const opsPerSec = (ops / durationMs) * 1000;
  const mbPerSec = (opsPerSec * payloadBytes) / (1024 * 1024);
  console.log(
    `[bench] ${label}: ${ops} ops in ${durationMs.toFixed(0)}ms — ${opsPerSec.toFixed(0)} ops/s (${mbPerSec.toFixed(1)} MB/s)`,
  );
  return { ops, durationMs, opsPerSec, mbPerSec };
}

async function measureLatencyP95(
  label: string,
  iterations: number,
  step: () => Promise<unknown>,
): Promise<{ p50: number; p95: number; p99: number }> {
  for (let i = 0; i < 5; i++) await step();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t = performance.now();
    await step();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const pct = (q: number): number => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))]!;
  const p50 = pct(0.5);
  const p95 = pct(0.95);
  const p99 = pct(0.99);
  console.log(
    `[bench] ${label}: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms (n=${iterations})`,
  );
  return { p50, p95, p99 };
}

describe.skipIf(!BENCH)("session-cipher throughput", () => {
  test("encryptFrame + decryptFrame at 4KB", async () => {
    const PAYLOAD = new Uint8Array(PAYLOAD_BYTES);
    crypto.getRandomValues(PAYLOAD);
    const sessionId = "bench-session";

    const host = await generateHostKeypair();
    const hostPriv = await importHostPrivateKey(host.privateKeyJwk);
    const attach = await generateAttachKeypair();
    const derivedHost = await deriveSessionKey({
      ourPrivateKey: hostPriv,
      theirPublicKeyRaw: attach.publicKeyRaw,
      sessionId,
    });
    const derivedAttach = await deriveSessionKey({
      ourPrivateKey: attach.privateKey,
      theirPublicKeyRaw: host.publicKeyRaw,
      sessionId,
    });
    const hostRandom = generateSessionRandom();
    const attachRandom = generateSessionRandom();

    let counter = 0n;
    await measureThroughput("encryptFrame(4KB) host→attach", PAYLOAD_BYTES, async () => {
      await encryptFrame({
        aesKey: derivedHost.aesKey,
        counter: counter++,
        sessionRandom: hostRandom,
        aadSessionPrefix: derivedHost.aadSessionPrefix,
        direction: DIRECTION_HOST_TO_ATTACH,
        plaintext: PAYLOAD,
      });
    });

    let attachCounter = 0n;
    await measureThroughput("encryptFrame(4KB) attach→host", PAYLOAD_BYTES, async () => {
      await encryptFrame({
        aesKey: derivedAttach.aesKey,
        counter: attachCounter++,
        sessionRandom: attachRandom,
        aadSessionPrefix: derivedHost.aadSessionPrefix,
        direction: DIRECTION_ATTACH_TO_HOST,
        plaintext: PAYLOAD,
      });
    });

    const sealed = await encryptFrame({
      aesKey: derivedHost.aesKey,
      counter: counter++,
      sessionRandom: hostRandom,
      aadSessionPrefix: derivedHost.aadSessionPrefix,
      direction: DIRECTION_HOST_TO_ATTACH,
      plaintext: PAYLOAD,
    });
    await measureThroughput("decryptFrame(4KB) host→attach", PAYLOAD_BYTES, async () => {
      // lastCounter = -1n so the same pre-sealed frame replays without
      // tripping the strict-monotonic check — measuring AEAD cost only.
      await decryptFrame({
        aesKey: derivedAttach.aesKey,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        aadSessionPrefix: derivedHost.aadSessionPrefix,
        direction: DIRECTION_HOST_TO_ATTACH,
        lastCounter: -1n,
      });
    });
  }, 60_000);

  test("deriveSessionKey latency p95", async () => {
    const sessionId = "bench-derive";
    await measureLatencyP95("deriveSessionKey", 50, async () => {
      const h = await generateHostKeypair();
      const hp = await importHostPrivateKey(h.privateKeyJwk);
      const a = await generateAttachKeypair();
      await deriveSessionKey({
        ourPrivateKey: hp,
        theirPublicKeyRaw: a.publicKeyRaw,
        sessionId,
      });
    });
  }, 60_000);
});
