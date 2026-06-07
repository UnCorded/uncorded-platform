import { describe, expect, test } from "bun:test";
import { StdioParentTransport, MAX_IPC_LINE_BYTES } from "./transport";
import type { IpcMessage, OverflowDetails } from "./transport";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = resolve(import.meta.dir, "..", "__fixtures__");

/** Poll until condition is true, with timeout. */
function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = setInterval(() => {
      if (condition()) {
        clearInterval(check);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        reject(new Error("waitFor timed out"));
      }
    }, 5);
  });
}

// ---------------------------------------------------------------------------
// StdioParentTransport unit tests (mock streams)
// ---------------------------------------------------------------------------

describe("StdioParentTransport — unit", () => {
  test("send() writes JSON line to stdin", () => {
    const chunks: string[] = [];

    const mockStdin = {
      write(data: string) { chunks.push(data); },
      flush() {},
      end() {},
    };

    const transport = new StdioParentTransport(mockStdin, null);
    transport.send({ type: "ping" });

    expect(chunks.join("")).toBe('{"type":"ping"}\n');
    transport.close();
  });

  test("receives IPC-prefixed messages from stdout", async () => {
    const received: IpcMessage[] = [];

    // Create a readable stream that emits IPC messages
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('IPC:{"type":"ready"}\n'));
        controller.enqueue(encoder.encode('IPC:{"type":"data","id":"1"}\n'));
        controller.close();
      },
    });

    const transport = new StdioParentTransport(null, stdout);
    transport.onMessage((msg) => received.push(msg));

    await waitFor(() => received.length >= 2);

    expect(received[0]!.type).toBe("ready");
    expect(received[1]!.type).toBe("data");
    expect(received[1]!.id).toBe("1");
    transport.close();
  });

  test("non-IPC lines routed to log handler", async () => {
    const logs: string[] = [];

    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("Some log output\n"));
        controller.enqueue(encoder.encode('IPC:{"type":"ready"}\n'));
        controller.enqueue(encoder.encode("Another log line\n"));
        controller.close();
      },
    });

    const received: IpcMessage[] = [];
    const transport = new StdioParentTransport(null, stdout, (line) => logs.push(line));
    transport.onMessage((msg) => received.push(msg));

    await waitFor(() => received.length >= 1 && logs.length >= 2);

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("ready");
    expect(logs).toContain("Some log output");
    expect(logs).toContain("Another log line");
    transport.close();
  });

  test("close() stops sending and receiving", () => {
    const chunks: string[] = [];
    const mockStdin = {
      write(data: string) { chunks.push(data); },
      flush() {},
      end() {},
    };

    const transport = new StdioParentTransport(mockStdin, null);
    transport.close();

    transport.send({ type: "ping" });

    expect(chunks).toHaveLength(0);
  });

  test("malformed IPC lines logged as errors", async () => {
    const logs: string[] = [];

    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("IPC:not-json\n"));
        controller.enqueue(encoder.encode('IPC:{"type":"good"}\n'));
        controller.close();
      },
    });

    const received: IpcMessage[] = [];
    const transport = new StdioParentTransport(null, stdout, (line) => logs.push(line));
    transport.onMessage((msg) => received.push(msg));

    await waitFor(() => received.length >= 1);

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("good");
    expect(logs.some((l) => l.includes("ipc-parse-error"))).toBe(true);
    transport.close();
  });

  test("multiple handlers all receive messages", async () => {
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('IPC:{"type":"test"}\n'));
        controller.close();
      },
    });

    const a: IpcMessage[] = [];
    const b: IpcMessage[] = [];
    const transport = new StdioParentTransport(null, stdout);
    transport.onMessage((msg) => a.push(msg));
    transport.onMessage((msg) => b.push(msg));

    await waitFor(() => a.length >= 1 && b.length >= 1);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    transport.close();
  });

  test("inbound overflow: buffer exceeding cap without newline fires onOverflow and halts reader", async () => {
    const overflows: OverflowDetails[] = [];
    const received: IpcMessage[] = [];
    const logs: string[] = [];

    // Emit MAX_IPC_LINE_BYTES + 1 bytes with no newline, in small chunks so the
    // reader's per-chunk cap check triggers before the stream completes.
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const chunkSize = 64 * 1024;
        const chunk = encoder.encode("a".repeat(chunkSize));
        let sent = 0;
        while (sent <= MAX_IPC_LINE_BYTES) {
          controller.enqueue(chunk);
          sent += chunkSize;
        }
        controller.close();
      },
    });

    const transport = new StdioParentTransport(
      null,
      stdout,
      (line) => logs.push(line),
      (details) => overflows.push(details),
    );
    transport.onMessage((msg) => received.push(msg));

    await waitFor(() => overflows.length >= 1);

    expect(overflows).toHaveLength(1);
    expect(overflows[0]!.direction).toBe("inbound");
    expect(overflows[0]!.byteLength).toBeGreaterThan(MAX_IPC_LINE_BYTES);
    expect(received).toHaveLength(0);
    expect(logs.some((l) => l.includes("ipc-inbound-overflow"))).toBe(true);
    transport.close();
  });

  test("outbound overflow: send() drops messages larger than cap and fires onOverflow", () => {
    const chunks: string[] = [];
    const overflows: OverflowDetails[] = [];
    const logs: string[] = [];

    const mockStdin = {
      write(data: string) { chunks.push(data); },
      flush() {},
      end() {},
    };

    const transport = new StdioParentTransport(
      mockStdin,
      null,
      (line) => logs.push(line),
      (details) => overflows.push(details),
    );

    // Build a message whose JSON-encoded form exceeds the cap.
    const big = "x".repeat(MAX_IPC_LINE_BYTES + 100);
    transport.send({ type: "response", id: "1", result: big } as IpcMessage);

    expect(chunks).toHaveLength(0);
    expect(overflows).toHaveLength(1);
    expect(overflows[0]!.direction).toBe("outbound");
    expect(overflows[0]!.byteLength).toBeGreaterThan(MAX_IPC_LINE_BYTES);
    expect(logs.some((l) => l.includes("ipc-outbound-overflow"))).toBe(true);

    // A small message after an overflow still goes through — send() is not
    // permanently closed on outbound overflow (unlike inbound).
    transport.send({ type: "ping" });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('{"type":"ping"}\n');

    transport.close();
  });
});

// ---------------------------------------------------------------------------
// Integration test: real IPC round-trip with subprocess
// ---------------------------------------------------------------------------

describe("IPC round-trip (real subprocess)", () => {
  test("send and receive messages via stdio IPC", async () => {
    const allMessages: IpcMessage[] = [];
    const logs: string[] = [];

    const proc = Bun.spawn(["bun", "run", resolve(FIXTURES_DIR, "echo-plugin.ts")], {
      cwd: FIXTURES_DIR,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const transport = new StdioParentTransport(
      proc.stdin,
      proc.stdout,
      (line) => logs.push(line),
    );
    transport.onMessage((msg) => allMessages.push(msg));

    // Wait for "ready"
    await waitFor(() => allMessages.some((m) => m.type === "ready"));
    expect(allMessages[0]!.type).toBe("ready");

    // Send a test message and wait for echo
    transport.send({ type: "test", payload: "hello" });
    await waitFor(() => allMessages.some((m) => m.type === "echo"));

    const echo = allMessages.find((m) => m.type === "echo")!;
    expect(echo["original_type"]).toBe("test");
    expect(echo["payload"]).toBe("hello");

    // Clean up
    transport.close();
    proc.kill("SIGTERM");
    await proc.exited;
  });
});
