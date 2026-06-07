// Test fixture: plugin that sends "ready" then crashes after 100ms.
// Used to test the restart loop in SubprocessManager.

export {};

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`IPC:${JSON.stringify(msg)}\n`);
}

send({ type: "ready" });

setTimeout(() => {
  process.exit(1);
}, 100);
