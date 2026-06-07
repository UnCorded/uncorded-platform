// TCP reachability probe — opens a connection, measures handshake latency,
// closes immediately. Never sends or reads data. Spec-24 Amendment A2 #1.
//
// Used to verify LiveKit's TCP fallback (default port 7881) is reachable
// from the public internet.

import { connect, type Socket } from "node:net";
import type { PortGroupResult } from "./types";

export interface TcpProbeOptions {
  host: string;
  port: number;
  /** Hard wall-clock cap. Default 5000ms — keeps the parallel probe budget ≤ 10s. */
  timeoutMs?: number;
}

/**
 * Open a TCP connection to host:port and resolve once the kernel reports the
 * three-way handshake complete (`connect` event). Closes the socket
 * immediately on success. Never throws.
 */
export async function tcpProbe(opts: TcpProbeOptions): Promise<PortGroupResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const start = Date.now();

  return await new Promise<PortGroupResult>((resolve) => {
    let settled = false;
    let socket: Socket | null = null;

    const finish = (result: PortGroupResult): void => {
      if (settled) return;
      settled = true;
      if (socket) {
        try { socket.destroy(); } catch { /* ignore */ }
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ reachable: false, latencyMs: null, error: "ETIMEDOUT" });
    }, timeoutMs);

    try {
      socket = connect({ host: opts.host, port: opts.port });
      socket.once("connect", () => {
        clearTimeout(timer);
        finish({ reachable: true, latencyMs: Date.now() - start, error: null });
      });
      socket.once("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        finish({
          reachable: false,
          latencyMs: null,
          error: err.code ?? err.message ?? "ECONNERROR",
        });
      });
    } catch (err) {
      clearTimeout(timer);
      const code = err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : null;
      finish({ reachable: false, latencyMs: null, error: code ?? "ECONNERROR" });
    }
  });
}
