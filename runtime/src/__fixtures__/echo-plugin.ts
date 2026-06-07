// Test fixture: minimal plugin using stdio-based IPC.
// Sends "ready", then echoes any incoming message.

export {};

// Send IPC message via stdout with "IPC:" prefix
function send(msg: Record<string, unknown>): void {
  process.stdout.write(`IPC:${JSON.stringify(msg)}\n`);
}

// Read IPC messages from stdin (newline-delimited JSON)
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
        if (msg["type"] === "shutdown") {
          process.exit(0);
        }
        // Echo the message back
        send({ ...msg, type: "echo", original_type: msg["type"] });
      } catch {
        // Skip malformed messages
      }
    }
  }
}

// Send ready signal
send({ type: "ready" });

// Start reading
readMessages();
