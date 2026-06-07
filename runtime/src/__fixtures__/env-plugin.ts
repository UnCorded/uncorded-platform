// Test fixture: sends "ready", then reports its environment variables via IPC.

export {};

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`IPC:${JSON.stringify(msg)}\n`);
}

// Send ready signal
send({ type: "ready" });

// Send environment info
send({
  type: "env_report",
  plugin_slug: process.env["PLUGIN_SLUG"] ?? null,
  plugin_data_dir: process.env["PLUGIN_DATA_DIR"] ?? null,
  plugin_api_version: process.env["PLUGIN_API_VERSION"] ?? null,
  env_keys: Object.keys(process.env),
});

// Stay alive
async function readMessages(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

readMessages();
