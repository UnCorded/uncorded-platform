// Test fixture: plugin that delays responses.
// Reads the `delay` field from request params (defaults to 60s).
// Used to test timeout cleanup and concurrent request accumulation.

export {};

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`IPC:${JSON.stringify(msg)}\n`);
}

async function readMessages(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.length === 0) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;

        if (msg["type"] === "request") {
          const params = msg["params"] as Record<string, unknown> | undefined;
          const delay = typeof params?.["delay"] === "number" ? params["delay"] : 60_000;
          setTimeout(() => {
            send({
              type: "response",
              id: msg["id"],
              result: { delayed: true, delayMs: delay },
            });
          }, delay);
        } else if (msg["type"] === "shutdown") {
          process.exit(0);
        }
      } catch {
        // Skip malformed
      }
    }
  }
}

send({ type: "ready" });
readMessages();
