// Child-side IPC transport — newline-delimited JSON over stdin/stdout.
// This is the plugin's side of the stdio IPC channel.
//
// Protocol:
//   Runtime → Plugin: JSON lines written to the plugin's stdin
//   Plugin → Runtime: stdout lines prefixed with "IPC:" are IPC messages,
//                     all other stdout lines are treated as log output

// ---------------------------------------------------------------------------
// Types — canonical definitions live in @uncorded/protocol; imported and
// re-exported here for backwards compatibility with direct consumers.
// ---------------------------------------------------------------------------

import type { IpcMessage, IpcTransport, MessageHandler } from "@uncorded/protocol";
import { encodeIpcJson, decodeIpcJson } from "@uncorded/protocol";
export type { IpcMessage, IpcTransport, MessageHandler };

// ---------------------------------------------------------------------------
// Child-side transport (plugin subprocess → runtime via stdio)
// ---------------------------------------------------------------------------

/**
 * Creates a child-side transport:
 *   - Reads JSON lines from stdin (messages from runtime)
 *   - Writes "IPC:"-prefixed JSON lines to stdout (messages to runtime)
 *   - Regular console.log output should use stderr or be prefixed differently
 */
export function createChildTransport(): IpcTransport {
  const handlers: MessageHandler[] = [];
  let closed = false;
  let buffer = "";
  const handleStdoutError = () => {
    closed = true;
  };

  const readStdin = async () => {
    try {
      const reader = Bun.stdin.stream().getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.length === 0 || closed) continue;
          try {
            const msg = decodeIpcJson(line) as IpcMessage;
            for (const handler of handlers) {
              handler(msg);
            }
          } catch {
            // Malformed message — skip
          }
        }
      }
    } catch {
      // stdin closed
    }
  };

  process.stdout.on("error", handleStdoutError);
  readStdin();

  return {
    send(message: IpcMessage): void {
      if (closed) return;
      try {
        process.stdout.write(`IPC:${encodeIpcJson(message)}\n`);
      } catch {
        closed = true;
      }
    },

    onMessage(handler: MessageHandler): void {
      handlers.push(handler);
    },

    close(): void {
      closed = true;
      handlers.length = 0;
      process.stdout.off("error", handleStdoutError);
    },
  };
}
