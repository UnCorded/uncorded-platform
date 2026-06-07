// Test fixture: plugin that handles requests.
// Sends "ready" on startup.
// Handles type="request" — echoes back as response with the action and params.

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

        switch (msg["type"]) {
          case "request":
            send({
              type: "response",
              id: msg["id"],
              result: { echo: true, action: msg["action"], params: msg["params"] },
            });
            break;

          case "shutdown":
            process.exit(0);
            break;
        }
      } catch {
        // Skip malformed
      }
    }
  }
}

send({ type: "ready" });
readMessages();
