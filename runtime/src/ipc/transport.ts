// IPC transport — newline-delimited JSON over stdin/stdout.
// Works identically on Windows, Linux, and macOS.
//
// Protocol:
//   Runtime → Plugin: JSON lines written to the plugin's stdin
//   Plugin → Runtime: stdout lines prefixed with "IPC:" are IPC messages,
//                     all other stdout lines are treated as log output
//   stderr: always routed to the log collector (handled outside transport)

// ---------------------------------------------------------------------------
// Types — canonical definitions live in @uncorded/protocol; imported and
// re-exported here for backwards compatibility with direct consumers.
// ---------------------------------------------------------------------------

import type { IpcMessage, IpcTransport, MessageHandler } from "@uncorded/protocol";
import { encodeIpcJson, decodeIpcJson } from "@uncorded/protocol";
import { IpcMessageSchema } from "@uncorded/protocol-schemas";
export type { IpcMessage, IpcTransport, MessageHandler };

/** Minimal writer interface — works with Bun's FileSink and WritableStream. */
export interface StdinWriter {
  write(data: string | Uint8Array): unknown;
  flush?(): unknown;
  end?(): unknown;
}

/**
 * Hard cap on a single newline-delimited IPC line, inbound or outbound.
 * A plugin that writes more than this without emitting a newline is misbehaving
 * (infinite loop, runaway query result, or deliberately trying to OOM the
 * runtime). The reader halts and notifies `onOverflow` before the buffer grows
 * unbounded; the owner (SubprocessManager) kills the subprocess.
 *
 * Callers that produce large responses should reject earlier with a catchable
 * RESPONSE_TOO_LARGE error — see `sendBoundedResult` in ipc/handlers.ts. This
 * transport-level cap is a final safety net.
 */
export const MAX_IPC_LINE_BYTES = 4 * 1024 * 1024; // 4 MB

export interface OverflowDetails {
  /** Bytes buffered (inbound) or attempted (outbound) when the cap was exceeded. */
  byteLength: number;
  /** Which direction overflowed. */
  direction: "inbound" | "outbound";
}

// Bun's FileSink returns a Promise from flush()/end(). When the subprocess has
// already died, that promise rejects with EPIPE *asynchronously* — a surrounding
// try/catch only catches the sync write() throw, not the post-write flush
// rejection. If we don't attach a .catch, the rejection surfaces as an
// unhandled rejection long after the send site has returned.
function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

// ---------------------------------------------------------------------------
// Parent-side transport (runtime → plugin subprocess via stdio)
// ---------------------------------------------------------------------------

export class StdioParentTransport implements IpcTransport {
  private handlers: MessageHandler[] = [];
  private closed = false;
  private encoder = new TextEncoder();

  constructor(
    private stdinWriter: StdinWriter | null,
    stdout: ReadableStream<Uint8Array> | null,
    private logHandler?: (line: string) => void,
    /** Fired when an IPC line exceeds MAX_IPC_LINE_BYTES. Expected to kill the subprocess. */
    private onOverflow?: (details: OverflowDetails) => void,
  ) {
    if (stdout) {
      this.startReading(stdout);
    }
  }

  send(message: IpcMessage): void {
    if (this.closed || !this.stdinWriter) return;
    const line = encodeIpcJson(message) + "\n";
    // Safety net — handlers that produce large responses should reject earlier
    // via sendBoundedResult. If we get here, drop the message rather than
    // overwhelm the plugin's stdin reader.
    const byteLength = this.encoder.encode(line).byteLength;
    if (byteLength > MAX_IPC_LINE_BYTES) {
      this.logHandler?.(
        `[ipc-outbound-overflow] dropped message of ${String(byteLength)} bytes (cap ${String(MAX_IPC_LINE_BYTES)})`,
      );
      this.onOverflow?.({ byteLength, direction: "outbound" });
      return;
    }
    try {
      this.stdinWriter.write(line);
      const flushResult = this.stdinWriter.flush?.();
      if (isThenable(flushResult)) {
        flushResult.catch(() => {
          // Subprocess died mid-flush (EPIPE). Same treatment as the sync throw below.
          this.closed = true;
          this.stdinWriter = null;
        });
      }
    } catch {
      // stdin closed — subprocess exited (EPIPE). Mark closed to prevent further sends.
      this.closed = true;
      this.stdinWriter = null;
    }
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  offMessage(handler: MessageHandler): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  close(): void {
    this.closed = true;
    this.handlers = [];
    if (this.stdinWriter) {
      try {
        const endResult = this.stdinWriter.end?.();
        if (isThenable(endResult)) {
          // Subprocess already exited → EPIPE on flush-during-end. Benign; we're tearing down.
          endResult.catch(() => {});
        }
      } catch {
        // Already closed
      }
      this.stdinWriter = null;
    }
  }

  private async startReading(stdout: ReadableStream<Uint8Array>): Promise<void> {
    try {
      const reader = stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Check before split: a plugin writing a huge payload without a newline
        // must not be allowed to grow the buffer indefinitely. We check the
        // buffer length (string chars) — TextEncoder byte count would be more
        // precise, but UTF-8 bytes >= UTF-16 chars, so a char-count cap is a
        // conservative lower bound that still halts runaway plugins fast.
        if (buffer.length > MAX_IPC_LINE_BYTES) {
          this.closed = true;
          this.logHandler?.(
            `[ipc-inbound-overflow] buffer ${String(buffer.length)} bytes exceeded cap ${String(MAX_IPC_LINE_BYTES)} with no newline`,
          );
          this.onOverflow?.({ byteLength: buffer.length, direction: "inbound" });
          try {
            reader.releaseLock();
          } catch {
            // Reader may already be released
          }
          return;
        }

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          this.processLine(line);
        }
      }

      // Flush remaining buffer
      if (buffer.length > 0) {
        this.processLine(buffer);
      }
    } catch {
      // Stream closed — expected on subprocess exit
    }
  }

  private processLine(line: string): void {
    if (line.length === 0 || this.closed) return;

    if (line.startsWith("IPC:")) {
      const json = line.slice(4);
      let raw: unknown;
      try {
        raw = decodeIpcJson(json);
      } catch {
        this.logHandler?.(`[ipc-parse-error] ${json}`);
        return;
      }
      // Envelope-validate before dispatching so a plugin sending a malformed
      // frame (missing `type`, non-string `id`, etc.) is dropped at the boundary
      // instead of triggering downstream `msg["type"] === "..."` confusion. The
      // per-action shape (`params`, `result`, etc.) is validated by
      // capability-specific handlers further in.
      const parsed = IpcMessageSchema.safeParse(raw);
      if (!parsed.success) {
        this.logHandler?.(`[ipc-schema-error] ${parsed.error.message} :: ${json}`);
        return;
      }
      for (const handler of this.handlers) {
        handler(parsed.data);
      }
    } else {
      this.logHandler?.(line);
    }
  }
}

// Child-side transport has moved to @uncorded/plugin-sdk.
// Plugin authors import { createPlugin } from "@uncorded/plugin-sdk".
