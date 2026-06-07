import { describe, expect, test } from "bun:test";
import type { IpcMessage, IpcTransport, MessageHandler } from "../transport";
import { createRequestClient } from "../request";
import { createDbApi } from "../db";

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------

function createMockTransport() {
  const sent: IpcMessage[] = [];
  const handlers: MessageHandler[] = [];

  const transport: IpcTransport = {
    send(message: IpcMessage): void {
      sent.push(message);
    },
    onMessage(handler: MessageHandler): void {
      handlers.push(handler);
    },
    close(): void {
      handlers.length = 0;
    },
  };

  function receive(message: IpcMessage): void {
    for (const handler of handlers) {
      handler(message);
    }
  }

  return { transport, sent, receive };
}

// ---------------------------------------------------------------------------
// Helper: create client + db, wired for auto-reply
// ---------------------------------------------------------------------------

function makeDbWithReply(
  result?: unknown,
  error?: { code: string; message: string },
) {
  const mock = createMockTransport();
  const client = createRequestClient(mock.transport);
  const db = createDbApi(client);

  // Intercept sends and immediately reply via handleResponse
  const origSend = mock.transport.send.bind(mock.transport);
  mock.transport.send = (msg: IpcMessage) => {
    origSend(msg);
    if (msg.id) {
      const response: IpcMessage = error
        ? { type: "response", id: msg.id as string, error }
        : { type: "response", id: msg.id as string, result };
      client.handleResponse(response);
    }
  };

  return { mock, db };
}

// ---------------------------------------------------------------------------
// createDbApi tests
// ---------------------------------------------------------------------------

describe("createDbApi", () => {
  test("query: sends correct IPC message and resolves with rows", async () => {
    const rows = [{ id: "1", name: "Alice" }, { id: "2", name: "Bob" }];
    const { mock, db } = makeDbWithReply(rows);

    const result = await db.query("SELECT id, name FROM members", ["arg1"]);
    expect(result).toEqual(rows);

    // Verify the IPC message shape (first message is the query)
    const sent = mock.sent[0]!;
    expect(sent["type"]).toBe("data.sql");
    expect(sent["method"]).toBe("query");
    expect(sent["sql"]).toBe("SELECT id, name FROM members");
    expect(sent["params"]).toEqual(["arg1"]);
  });

  test("query: omits params field when not provided", async () => {
    const { mock, db } = makeDbWithReply([]);

    await db.query("SELECT 1");
    const sent = mock.sent[0]!;
    expect(sent["params"]).toBeUndefined();
  });

  test("run: sends correct IPC message and resolves with RunResult", async () => {
    const runResult = { changes: 1, lastInsertRowid: 42 };
    const { mock, db } = makeDbWithReply(runResult);

    const result = await db.run("INSERT INTO items (name) VALUES (?)", ["test"]);
    expect(result).toEqual(runResult);

    const sent = mock.sent[0]!;
    expect(sent["type"]).toBe("data.sql");
    expect(sent["method"]).toBe("run");
    expect(sent["sql"]).toBe("INSERT INTO items (name) VALUES (?)");
    expect(sent["params"]).toEqual(["test"]);
  });

  test("exec: sends method:exec with no params field", async () => {
    const { mock, db } = makeDbWithReply(null);

    await db.exec("PRAGMA journal_mode = WAL");

    const sent = mock.sent[0]!;
    expect(sent["type"]).toBe("data.sql");
    expect(sent["method"]).toBe("exec");
    expect(sent["sql"]).toBe("PRAGMA journal_mode = WAL");
    expect(sent["params"]).toBeUndefined();
  });

  test("batch: sends method:transaction with statements array", async () => {
    const batchResult = [{ changes: 1, lastInsertRowid: 0 }, { changes: 1, lastInsertRowid: 0 }];
    const { mock, db } = makeDbWithReply(batchResult);

    const statements = [
      { sql: "UPDATE foo SET x = ?", params: [1] },
      { sql: "UPDATE bar SET y = ?", params: [2] },
    ];
    const result = await db.batch(statements);
    expect(result).toEqual(batchResult);

    const sent = mock.sent[0]!;
    expect(sent["type"]).toBe("data.sql");
    expect(sent["method"]).toBe("transaction");
    expect(sent["statements"]).toEqual(statements);
  });

  test("run: rejects on error response", async () => {
    const { db } = makeDbWithReply(
      undefined,
      { code: "DATABASE_ERROR", message: "table not found" },
    );

    await expect(db.run("UPDATE nonexistent SET x = 1")).rejects.toMatchObject({
      code: "DATABASE_ERROR",
      message: "table not found",
    });
  });
});
