// UDP reachability probe — sends a STUN Binding Request (RFC 5389 §6) and
// waits for a Binding Response. LiveKit answers STUN binding requests on
// every UDP port in its RTC range, so any one mid-range port is sufficient
// to verify the whole UDP RTC slab is reachable.
//
// Hand-rolled to avoid pulling an npm dep for ~80 lines of well-defined
// header packing. Reference: RFC 5389 §6 (message format), §15.1 (XOR-MAPPED-ADDRESS).

import { createSocket, type RemoteInfo } from "node:dgram";
import { randomBytes } from "node:crypto";
import type { PortGroupResult } from "./types";

export interface StunProbeOptions {
  host: string;
  port: number;
  /** Hard wall-clock cap. Default 5000ms. Per-attempt timeout is timeoutMs / retries. */
  timeoutMs?: number;
  /** Number of binding-request attempts. Default 3 (RFC 5389 §7.2.1 recommends 7; we stay tight for our 10s probe budget). */
  retries?: number;
}

const STUN_BINDING_REQUEST = 0x0001;
const STUN_BINDING_RESPONSE = 0x0101;
const STUN_BINDING_ERROR_RESPONSE = 0x0111;
const STUN_MAGIC_COOKIE = 0x2112_a442;

function buildBindingRequest(transactionId: Buffer): Buffer {
  // 20-byte header, no attributes. RFC 5389 §6:
  //   0..1   message type (0x0001 = Binding Request)
  //   2..3   message length (0 — no attrs)
  //   4..7   magic cookie (0x2112A442)
  //   8..19  96-bit transaction ID
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(STUN_BINDING_REQUEST, 0);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  transactionId.copy(buf, 8, 0, 12);
  return buf;
}

interface ParseResult {
  ok: boolean;
  reason?: string;
}

function isMatchingResponse(packet: Buffer, expectedTxId: Buffer): ParseResult {
  if (packet.length < 20) return { ok: false, reason: "STUN_TRUNCATED" };
  const messageType = packet.readUInt16BE(0);
  if (messageType !== STUN_BINDING_RESPONSE && messageType !== STUN_BINDING_ERROR_RESPONSE) {
    return { ok: false, reason: "STUN_UNEXPECTED_TYPE" };
  }
  if (packet.readUInt32BE(4) !== STUN_MAGIC_COOKIE) {
    return { ok: false, reason: "STUN_BAD_COOKIE" };
  }
  // Compare 12-byte transaction id at offset 8.
  for (let i = 0; i < 12; i++) {
    if (packet[8 + i] !== expectedTxId[i]) return { ok: false, reason: "STUN_TXID_MISMATCH" };
  }
  if (messageType === STUN_BINDING_ERROR_RESPONSE) return { ok: false, reason: "STUN_ERROR_RESPONSE" };
  return { ok: true };
}

/**
 * Send up to `retries` STUN binding requests to host:port over UDP. Resolve
 * `reachable: true` on the first valid binding response; `reachable: false`
 * if every retry times out or the response fails validation. Never throws.
 */
export async function stunProbe(opts: StunProbeOptions): Promise<PortGroupResult> {
  const totalBudgetMs = opts.timeoutMs ?? 5000;
  const retries = Math.max(1, opts.retries ?? 3);
  const perAttemptMs = Math.floor(totalBudgetMs / retries);
  const start = Date.now();

  const txId = randomBytes(12);
  const packet = buildBindingRequest(txId);

  return await new Promise<PortGroupResult>((resolve) => {
    let settled = false;
    let attemptTimer: ReturnType<typeof setTimeout> | null = null;
    let attemptsRemaining = retries;
    let lastReason: string = "STUN_TIMEOUT";
    const socket = createSocket("udp4");

    const finish = (result: PortGroupResult): void => {
      if (settled) return;
      settled = true;
      if (attemptTimer) clearTimeout(attemptTimer);
      try { socket.close(); } catch { /* ignore */ }
      resolve(result);
    };

    const sendAttempt = (): void => {
      if (attemptsRemaining <= 0) {
        finish({ reachable: false, latencyMs: null, error: lastReason });
        return;
      }
      attemptsRemaining -= 1;
      socket.send(packet, opts.port, opts.host, (err) => {
        if (err && !settled) {
          // ENETUNREACH / EHOSTUNREACH on send → terminate; retries won't help.
          const code = (err as NodeJS.ErrnoException).code ?? "ESEND";
          finish({ reachable: false, latencyMs: null, error: code });
        }
      });
      attemptTimer = setTimeout(sendAttempt, perAttemptMs);
    };

    socket.on("message", (msg: Buffer, _rinfo: RemoteInfo) => {
      const result = isMatchingResponse(msg, txId);
      if (result.ok) {
        finish({ reachable: true, latencyMs: Date.now() - start, error: null });
      } else {
        // Note for future: don't terminate on a single bad packet — late
        // duplicate from a prior probe could land here. Track reason and
        // let timeout drive the failure path.
        lastReason = result.reason ?? "STUN_INVALID";
      }
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      finish({ reachable: false, latencyMs: null, error: err.code ?? "ESOCKET" });
    });

    try {
      socket.bind(0, () => sendAttempt());
    } catch (err) {
      const code = err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : null;
      finish({ reachable: false, latencyMs: null, error: code ?? "EBIND" });
    }
  });
}
