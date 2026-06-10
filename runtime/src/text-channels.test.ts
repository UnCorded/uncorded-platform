/**
 * Integration test for the text-channels core plugin.
 *
 * Proves the full runtime lifecycle:
 *   boot → load manifest → run migrations → spawn subprocess → IPC handshake
 *   → handle requests → store in SQLite → publish events → broadcast via WS
 *
 * Uses the REAL plugin source from plugins/text-channels/ against a real
 * boot() call with mock external dependencies (tunnel, Central, token validator).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";
import { boot } from "./main";
import type {
  BootDependencies,
  BootResult,
  ServerJsonConfig,
  TunnelProvider,
} from "./main";
import type { TokenValidator, TokenValidationResult } from "./ws/types";
import type { HeartbeatResponse, PublicKeyEntry } from "./heartbeat/types";

function mkKey(id: string): PublicKeyEntry {
  return { id, public_key: { kty: "OKP", crv: "Ed25519", x: id } as JsonWebKey };
}
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Absolute path to the real plugins/text-channels/ directory. */
const REAL_PLUGINS_DIR = resolve(import.meta.dir, "../../plugins");

// ---------------------------------------------------------------------------
// Test fixtures (mirrors main.test.ts patterns)
// ---------------------------------------------------------------------------

function validServerConfig(
  overrides?: Partial<ServerJsonConfig>,
): ServerJsonConfig {
  return {
    server_id: "server_tc_test",
    server_secret: "sk_test_secret",
    central_url: "https://central.uncorded.app",
    installed_plugins: ["text-channels"],
    tunnel: { provider: "cloudflare", mode: "demo" },
    settings: {
      permissive_mode: false,
      max_connections: 100,
      allow_unsigned_plugins: false,
    },
    ...overrides,
  };
}

function createMockTunnelProvider(): TunnelProvider {
  return {
    async start() {
      return "https://test.trycloudflare.com";
    },
    async stop() {},
    getUrl() {
      return "https://test.trycloudflare.com";
    },
    getState() {
      return "demo";
    },
    async healthCheck() {
      return true;
    },
  };
}

function createMockTokenValidator(): TokenValidator {
  return {
    async validate(token: string): Promise<TokenValidationResult> {
      if (token === "valid-token") {
        return {
          ok: true,
          user: {
            id: "user_1",
            username: "test_user",
            displayName: "Test User",
            avatarUrl: "",
            role: "member",
          },
        };
      }
      if (token === "mod-token") {
        return {
          ok: true,
          user: {
            id: "user_mod",
            username: "mod_user",
            displayName: "Mod User",
            avatarUrl: "",
            role: "moderator",
          },
        };
      }
      // Dynamic pattern: "user-<sub>-token" maps to user_<sub>. Lets tests
      // spin up arbitrary numbers of distinct users (e.g. for broadcast-
      // audience-cap coverage).
      const match = token.match(/^user-([a-zA-Z0-9_-]+)-token$/);
      if (match) {
        const sub = match[1]!;
        return {
          ok: true,
          user: {
            id: `user_${sub}`,
            username: `user_${sub}`,
            displayName: `User ${sub}`,
            avatarUrl: "",
            role: "member",
          },
        };
      }
      return { ok: false, code: "INVALID_TOKEN", message: "Invalid token" };
    },
  };
}

function dirtyResponse(
  overrides?: Partial<Extract<HeartbeatResponse, { dirty: true }>>,
): HeartbeatResponse {
  return {
    dirty: true,
    sync_version: 10,
    public_keys: [mkKey("key-a")],
    deltas: [],
    ...overrides,
  };
}

type MockFetch = NonNullable<BootDependencies["fetch"]>;

function createMockFetch(): MockFetch {
  return (async (
    input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return new Response(JSON.stringify(dirtyResponse()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as MockFetch;
}

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function createTmpDir(label: string): string {
  const dir = join(
    tmpdir(),
    `uncorded-tc-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Silence console during tests
// ---------------------------------------------------------------------------

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const swallowBrokenPipe = (error: Error) => {
  if ((error as NodeJS.ErrnoException).code === "EPIPE") {
    return;
  }
  throw error;
};

const swallowBrokenPipeRejection = (reason: unknown) => {
  if (
    reason !== null &&
    typeof reason === "object" &&
    (reason as NodeJS.ErrnoException).code === "EPIPE"
  ) {
    return;
  }
  throw reason;
};

beforeAll(() => {
  process.on("uncaughtException", swallowBrokenPipe);
  process.on("unhandledRejection", swallowBrokenPipeRejection);
});

beforeEach(() => {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let bootResult: BootResult | null = null;

afterEach(async () => {
  if (bootResult) {
    await bootResult.shutdown();
    bootResult = null;
  }
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  tmpDirs = [];

  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
});


// ---------------------------------------------------------------------------
// Boot helper
// ---------------------------------------------------------------------------

function createBootDeps(
  overrides?: Partial<BootDependencies>,
): { deps: BootDependencies; dataDir: string } {
  const tmpDir = createTmpDir("boot");
  const configDir = join(tmpDir, "config");
  const dataDir = join(tmpDir, "data");
  const userPluginsDir = join(tmpDir, "empty-plugins");

  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(dataDir, "plugins"), { recursive: true });
  mkdirSync(userPluginsDir, { recursive: true });

  // Create the per-plugin data directory the runtime expects
  mkdirSync(join(dataDir, "plugins", "text-channels"), { recursive: true });

  const config = validServerConfig();
  const configPath = join(configDir, "server.json");
  writeFileSync(configPath, JSON.stringify(config));

  const deps: BootDependencies = {
    tunnelProvider: createMockTunnelProvider(),
    tokenValidator: createMockTokenValidator(),
    configPath,
    corePluginsDir: REAL_PLUGINS_DIR,
    userPluginsDir,
    dataDir,
    runtimeVersion: "1.0.0",
    port: 0,
    fetch: createMockFetch(),
    ...overrides,
  };

  return { deps, dataDir };
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

/** Decode a WS message event (binary msgpack or text JSON fallback). */
function decodeWsEvent(event: MessageEvent): Record<string, unknown> {
  if (event.data instanceof ArrayBuffer) {
    return msgpackDecode(new Uint8Array(event.data)) as Record<string, unknown>;
  }
  return JSON.parse(String(event.data)) as Record<string, unknown>;
}

/** Open a WebSocket, authenticate, and return the ready connection. */
function connectWs(
  port: number,
  token: string,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${String(port)}/ws`);
    ws.binaryType = "arraybuffer";
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WS connect + auth timed out"));
    }, 10_000);

    ws.onopen = () => {
      ws.send(msgpackEncode({ type: "auth", token }));
    };

    ws.onmessage = (event) => {
      const msg = decodeWsEvent(event);
      if (msg["type"] === "auth.result") {
        clearTimeout(timeout);
        if (msg["ok"] === true) {
          // A small post-auth delay works around a Bun-1.3.13 WS-client race
          // where the very first response frame after auth.result can be
          // silently dropped on Windows. Without this, tests that issue their
          // first wsRequest before any other inbound frame arrives may hang.
          setTimeout(() => resolve(ws), 50);
        } else {
          ws.close();
          reject(new Error(`Auth failed: ${String(msg["error"])}`));
        }
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
}

/** Send a plugin request and wait for the matching response. */
function wsRequest(
  ws: WebSocket,
  id: string,
  plugin: string,
  action: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`WS request ${id} timed out`));
    }, 10_000);

    const handler = (event: MessageEvent) => {
      const msg = decodeWsEvent(event);
      if (msg["type"] === "response" && msg["id"] === id) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        if (msg["error"] !== undefined && msg["error"] !== null) {
          reject(
            new Error(
              (msg["error"] as Record<string, unknown>)["message"] as string,
            ),
          );
        } else {
          resolve(msg["result"] as Record<string, unknown>);
        }
      }
    };

    ws.addEventListener("message", handler);
    ws.send(msgpackEncode({ type: "request", id, plugin, action, params }));
  });
}

/** Collect events matching a topic until a timeout. */
function collectEvents(
  ws: WebSocket,
  topic: string,
  timeoutMs: number,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const events: Array<Record<string, unknown>> = [];
    const handler = (event: MessageEvent) => {
      const msg = decodeWsEvent(event);
      if (msg["type"] === "event" && msg["topic"] === topic) {
        events.push(msg["payload"] as Record<string, unknown>);
      }
    };
    ws.addEventListener("message", handler);
    setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolve(events);
    }, timeoutMs);
  });
}

// ===========================================================================
// Tests
// ===========================================================================

const GENERAL_CHANNEL_ID = "00000000-0000-0000-0000-000000000001";

describe("text-channels integration", () => {
  test("boot loads plugin, runs migrations, and seeds general channel", async () => {
    const { deps, dataDir } = createBootDeps();
    bootResult = await boot(deps);

    expect(bootResult.pluginCount).toBe(1);

    // Verify the database was created and migrations ran
    const dbPath = join(dataDir, "plugins", "text-channels", "text-channels.db");
    const db = new Database(dbPath, { readonly: true });

    try {
      // Tables exist
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map((t) => t.name);
      expect(tables).toContain("channels");
      expect(tables).toContain("messages");
      expect(tables).toContain("_migrations");

      // Index exists
      const indexes = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map((i) => i.name);
      expect(indexes).toContain("idx_messages_channel_time");

      // General channel was seeded
      const channels = db
        .query<{ id: string; name: string }, []>("SELECT id, name FROM channels")
        .all();
      expect(channels).toHaveLength(1);
      expect(channels[0]!.name).toBe("general");
      expect(channels[0]!.id).toBe(GENERAL_CHANNEL_ID);

      // Migrations were tracked (001 tables, 002 threads, 003 category_id, 004 attachments)
      const migrations = db
        .query<{ filename: string }, []>(
          "SELECT filename FROM _migrations ORDER BY filename ASC",
        )
        .all()
        .map((m) => m.filename);
      expect(migrations).toEqual([
        "001_create_tables.sql",
        "002_add_threads.sql",
        "003_add_category_id.sql",
        "004_attachments.sql",
      ]);

      // Thread columns + index exist
      const messageCols = db
        .query<{ name: string }, []>("PRAGMA table_info(messages)")
        .all()
        .map((c) => c.name);
      expect(messageCols).toContain("parent_message_id");
      expect(messageCols).toContain("reply_count");
      expect(messageCols).toContain("last_reply_at");
      expect(messageCols).toContain("attachments");
      expect(indexes).toContain("idx_messages_parent");
    } finally {
      db.close();
    }
  });

  test("sendMessage via WebSocket stores in DB and returns the message", async () => {
    const { deps, dataDir } = createBootDeps();
    bootResult = await boot(deps);

    const ws = await connectWs(bootResult.port, "valid-token");

    try {
      // Send a message
      const result = (await wsRequest(ws, "req_1", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "Hello, world!",
      })) as Record<string, unknown>;

      expect(result["content"]).toBe("Hello, world!");
      expect(result["channel_id"]).toBe(GENERAL_CHANNEL_ID);
      expect(result["author_id"]).toBe("user_1");
      expect(typeof result["id"]).toBe("string");
      expect(typeof result["created_at"]).toBe("number");

      // Verify it's in the database
      const dbPath = join(dataDir, "plugins", "text-channels", "text-channels.db");
      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db
          .query<{ id: string; content: string; author_id: string }, []>(
            "SELECT id, content, author_id FROM messages",
          )
          .all();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.content).toBe("Hello, world!");
        expect(rows[0]!.author_id).toBe("user_1");
      } finally {
        db.close();
      }
    } finally {
      ws.close();
    }
  });

  test("getChannels returns the seeded general channel", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);

    const ws = await connectWs(bootResult.port, "valid-token");

    try {
      const result = (await wsRequest(
        ws,
        "req_1",
        "text-channels",
        "getChannels",
        {},
      )) as unknown as Array<Record<string, unknown>>;

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]!["name"]).toBe("general");
      expect(result[0]!["id"]).toBe(GENERAL_CHANNEL_ID);
    } finally {
      ws.close();
    }
  });

  test("getMessages returns messages ordered by created_at desc", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);

    const ws = await connectWs(bootResult.port, "valid-token");

    try {
      // Send two messages
      await wsRequest(ws, "req_1", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "First",
      });
      await wsRequest(ws, "req_2", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "Second",
      });

      const result = (await wsRequest(
        ws,
        "req_3",
        "text-channels",
        "getMessages",
        { channel_id: GENERAL_CHANNEL_ID },
      )) as unknown as Array<Record<string, unknown>>;

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      // DESC order: newest first
      expect(result[0]!["content"]).toBe("Second");
      expect(result[1]!["content"]).toBe("First");
    } finally {
      ws.close();
    }
  });

  test("sendMessage broadcasts event to other connected clients", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);

    const sender = await connectWs(bootResult.port, "valid-token");
    const listener = await connectWs(bootResult.port, "valid-token");

    try {
      // Start collecting events on the listener before the message is sent
      const eventsPromise = collectEvents(
        listener,
        "text-channels.message.created",
        3_000,
      );

      // Small delay to ensure the listener is fully connected
      await new Promise((r) => setTimeout(r, 100));

      // Send a message from the sender
      await wsRequest(sender, "req_1", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "Broadcast test",
      });

      const events = await eventsPromise;
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]!["content"]).toBe("Broadcast test");
    } finally {
      sender.close();
      listener.close();
    }
  });

  test("editMessage updates content and sets edited_at", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);

    const ws = await connectWs(bootResult.port, "valid-token");

    try {
      const created = (await wsRequest(ws, "req_1", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "Original",
      })) as Record<string, unknown>;

      const edited = (await wsRequest(ws, "req_2", "text-channels", "editMessage", {
        message_id: created["id"],
        content: "Edited",
      })) as Record<string, unknown>;

      expect(edited["content"]).toBe("Edited");
      expect(edited["edited_at"]).not.toBeNull();
      expect(typeof edited["edited_at"]).toBe("number");
    } finally {
      ws.close();
    }
  });

  test("deleteMessage tombstones the message (row preserved, content + author scrubbed)", async () => {
    const { deps, dataDir } = createBootDeps();
    bootResult = await boot(deps);

    const ws = await connectWs(bootResult.port, "valid-token");

    try {
      const created = (await wsRequest(ws, "req_1", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "To be deleted",
      })) as Record<string, unknown>;

      const result = (await wsRequest(ws, "req_2", "text-channels", "deleteMessage", {
        message_id: created["id"],
      })) as Record<string, unknown>;

      expect(result["ok"]).toBe(true);

      const dbPath = join(dataDir, "plugins", "text-channels", "text-channels.db");
      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db
          .query<
            { id: string; content: string; author_id: string },
            [string]
          >("SELECT id, content, author_id FROM messages WHERE id = ?")
          .all(created["id"] as string);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.content).toBe("[deleted]");
        expect(rows[0]!.author_id).toBe("[deleted]");
      } finally {
        db.close();
      }
    } finally {
      ws.close();
    }
  });

  // =========================================================================
  // Threads
  // =========================================================================

  test("getMessages excludes thread replies", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);
    const ws = await connectWs(bootResult.port, "valid-token");

    try {
      const root = (await wsRequest(ws, "r1", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "root",
      })) as Record<string, unknown>;
      await wsRequest(ws, "r2", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "reply",
        parent_message_id: root["id"],
      });

      const messages = (await wsRequest(ws, "r3", "text-channels", "getMessages", {
        channel_id: GENERAL_CHANNEL_ID,
      })) as unknown as Array<Record<string, unknown>>;

      expect(messages).toHaveLength(1);
      expect(messages[0]!["content"]).toBe("root");
      expect(messages[0]!["parent_message_id"]).toBeNull();
    } finally {
      ws.close();
    }
  });

  test("sendMessage with parent_message_id stores reply and bumps parent counters atomically", async () => {
    const { deps, dataDir } = createBootDeps();
    bootResult = await boot(deps);
    const ws = await connectWs(bootResult.port, "valid-token");

    try {
      const root = (await wsRequest(ws, "r1", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "root",
      })) as Record<string, unknown>;

      const reply = (await wsRequest(ws, "r2", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "reply",
        parent_message_id: root["id"],
      })) as Record<string, unknown>;

      expect(reply["parent_message_id"]).toBe(root["id"]);

      const dbPath = join(dataDir, "plugins", "text-channels", "text-channels.db");
      const db = new Database(dbPath, { readonly: true });
      try {
        const parent = db
          .query<
            { reply_count: number; last_reply_at: number | null },
            [string]
          >("SELECT reply_count, last_reply_at FROM messages WHERE id = ?")
          .get(root["id"] as string);
        expect(parent).not.toBeNull();
        expect(parent!.reply_count).toBe(1);
        expect(typeof parent!.last_reply_at).toBe("number");
      } finally {
        db.close();
      }
    } finally {
      ws.close();
    }
  });

  test("sendMessage rejects a reply-to-a-reply (flat threads only)", async () => {
    // We assert on DB state rather than awaiting the thrown error response.
    // A known runtime-side issue causes error responses following multiple IPC
    // round-trips to not always reach the WS client in the test harness; the
    // handler-side throw IS observed (no insert occurs) and that's what we
    // verify here. Tracked separately.
    const { deps, dataDir } = createBootDeps();
    bootResult = await boot(deps);
    const ws = await connectWs(bootResult.port, "valid-token");

    try {
      const root = (await wsRequest(ws, "r1", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "root",
      })) as Record<string, unknown>;
      const reply = (await wsRequest(ws, "r2", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "reply",
        parent_message_id: root["id"],
      })) as Record<string, unknown>;

      // Fire a nested reply and wait for either response or timeout
      wsRequest(ws, "r3", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "nested reply",
        parent_message_id: reply["id"],
      }).catch(() => {
        // Error response may or may not arrive; we assert on DB state below.
      });

      // Give the plugin time to process (or reject)
      await new Promise((r) => setTimeout(r, 300));

      const dbPath = join(dataDir, "plugins", "text-channels", "text-channels.db");
      const db = new Database(dbPath, { readonly: true });
      try {
        const total = db
          .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM messages")
          .get();
        // Expect exactly 2 rows: the root and the one allowed reply. No third row.
        expect(total!.c).toBe(2);
        const nested = db
          .query<{ c: number }, [string]>(
            "SELECT COUNT(*) AS c FROM messages WHERE content = ?",
          )
          .get("nested reply");
        expect(nested!.c).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      ws.close();
    }
  });

  test("sendMessage rejects a parent_message_id pointing to a non-existent row", async () => {
    const { deps, dataDir } = createBootDeps();
    bootResult = await boot(deps);
    const ws = await connectWs(bootResult.port, "valid-token");

    try {
      wsRequest(ws, "r1", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "orphan reply",
        parent_message_id: "00000000-0000-0000-0000-deadbeefdead",
      }).catch(() => {
        // See DB-state assertion note above
      });

      await new Promise((r) => setTimeout(r, 300));

      const dbPath = join(dataDir, "plugins", "text-channels", "text-channels.db");
      const db = new Database(dbPath, { readonly: true });
      try {
        const orphan = db
          .query<{ c: number }, [string]>(
            "SELECT COUNT(*) AS c FROM messages WHERE content = ?",
          )
          .get("orphan reply");
        expect(orphan!.c).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      ws.close();
    }
  });

  test("getThreadReplies returns replies in chronological order", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);
    const ws = await connectWs(bootResult.port, "valid-token");

    try {
      const root = (await wsRequest(ws, "r1", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "root",
      })) as Record<string, unknown>;

      for (let i = 1; i <= 3; i++) {
        await wsRequest(ws, `rp${String(i)}`, "text-channels", "sendMessage", {
          channel_id: GENERAL_CHANNEL_ID,
          content: `reply ${String(i)}`,
          parent_message_id: root["id"],
        });
        await new Promise((r) => setTimeout(r, 5));
      }

      const replies = (await wsRequest(ws, "gt", "text-channels", "getThreadReplies", {
        message_id: root["id"],
      })) as unknown as Array<Record<string, unknown>>;

      expect(replies).toHaveLength(3);
      expect(replies[0]!["content"]).toBe("reply 1");
      expect(replies[1]!["content"]).toBe("reply 2");
      expect(replies[2]!["content"]).toBe("reply 3");
    } finally {
      ws.close();
    }
  });

  test("getThreadReplies honors before_created_at cursor", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);
    const ws = await connectWs(bootResult.port, "valid-token");

    try {
      const root = (await wsRequest(ws, "r1", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "root",
      })) as Record<string, unknown>;

      const replies: Array<Record<string, unknown>> = [];
      for (let i = 1; i <= 3; i++) {
        const reply = (await wsRequest(ws, `rp${String(i)}`, "text-channels", "sendMessage", {
          channel_id: GENERAL_CHANNEL_ID,
          content: `reply ${String(i)}`,
          parent_message_id: root["id"],
        })) as Record<string, unknown>;
        replies.push(reply);
        await new Promise((r) => setTimeout(r, 5));
      }

      const middle = replies[1]!;
      const filtered = (await wsRequest(ws, "gt", "text-channels", "getThreadReplies", {
        message_id: root["id"],
        before_created_at: middle["created_at"],
      })) as unknown as Array<Record<string, unknown>>;

      expect(filtered).toHaveLength(1);
      expect(filtered[0]!["content"]).toBe("reply 1");
    } finally {
      ws.close();
    }
  });

  test("getThreadReplies on a non-threaded message returns []", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);
    const ws = await connectWs(bootResult.port, "valid-token");

    try {
      const root = (await wsRequest(ws, "r1", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "lonely",
      })) as Record<string, unknown>;

      const replies = (await wsRequest(ws, "gt", "text-channels", "getThreadReplies", {
        message_id: root["id"],
      })) as unknown as Array<Record<string, unknown>>;

      expect(replies).toHaveLength(0);
    } finally {
      ws.close();
    }
  });

  test("deleteMessage tombstones a reply; parent reply_count unchanged", async () => {
    const { deps, dataDir } = createBootDeps();
    bootResult = await boot(deps);
    const ws = await connectWs(bootResult.port, "valid-token");

    try {
      const root = (await wsRequest(ws, "r1", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "root",
      })) as Record<string, unknown>;
      const reply = (await wsRequest(ws, "r2", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "reply",
        parent_message_id: root["id"],
      })) as Record<string, unknown>;

      await wsRequest(ws, "r3", "text-channels", "deleteMessage", {
        message_id: reply["id"],
      });

      const dbPath = join(dataDir, "plugins", "text-channels", "text-channels.db");
      const db = new Database(dbPath, { readonly: true });
      try {
        const parent = db
          .query<{ reply_count: number }, [string]>(
            "SELECT reply_count FROM messages WHERE id = ?",
          )
          .get(root["id"] as string);
        expect(parent!.reply_count).toBe(1);

        const replyRow = db
          .query<{ content: string; author_id: string }, [string]>(
            "SELECT content, author_id FROM messages WHERE id = ?",
          )
          .get(reply["id"] as string);
        expect(replyRow!.content).toBe("[deleted]");
        expect(replyRow!.author_id).toBe("[deleted]");
      } finally {
        db.close();
      }
    } finally {
      ws.close();
    }
  });

  test("deleteMessage tombstones a root that has replies; replies preserved", async () => {
    const { deps, dataDir } = createBootDeps();
    bootResult = await boot(deps);
    const ws = await connectWs(bootResult.port, "valid-token");

    try {
      const root = (await wsRequest(ws, "r1", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "root",
      })) as Record<string, unknown>;
      const reply = (await wsRequest(ws, "r2", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "reply",
        parent_message_id: root["id"],
      })) as Record<string, unknown>;

      await wsRequest(ws, "r3", "text-channels", "deleteMessage", {
        message_id: root["id"],
      });

      const dbPath = join(dataDir, "plugins", "text-channels", "text-channels.db");
      const db = new Database(dbPath, { readonly: true });
      try {
        const rootRow = db
          .query<{ content: string; reply_count: number }, [string]>(
            "SELECT content, reply_count FROM messages WHERE id = ?",
          )
          .get(root["id"] as string);
        expect(rootRow!.content).toBe("[deleted]");
        expect(rootRow!.reply_count).toBe(1);

        const replyRow = db
          .query<{ content: string }, [string]>(
            "SELECT content FROM messages WHERE id = ?",
          )
          .get(reply["id"] as string);
        expect(replyRow!.content).toBe("reply");
      } finally {
        db.close();
      }
    } finally {
      ws.close();
    }
  });

  test("message.deleted event payload includes parent_message_id", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);
    const sender = await connectWs(bootResult.port, "valid-token");
    const listener = await connectWs(bootResult.port, "valid-token");

    try {
      const root = (await wsRequest(sender, "r1", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "root",
      })) as Record<string, unknown>;
      const reply = (await wsRequest(sender, "r2", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "reply",
        parent_message_id: root["id"],
      })) as Record<string, unknown>;

      const eventsPromise = collectEvents(
        listener,
        "text-channels.message.deleted",
        3_000,
      );
      await new Promise((r) => setTimeout(r, 100));

      await wsRequest(sender, "r3", "text-channels", "deleteMessage", {
        message_id: reply["id"],
      });

      const events = await eventsPromise;
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]!["id"]).toBe(reply["id"]);
      expect(events[0]!["parent_message_id"]).toBe(root["id"]);
    } finally {
      sender.close();
      listener.close();
    }
  });

  // =========================================================================
  // Presence (typing + viewers)
  // =========================================================================

  test("setViewingChannel joins viewers presence and fans out viewers.updated broadcast", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);
    const ws = await connectWs(bootResult.port, "valid-token");

    try {
      const eventsPromise = collectEvents(
        ws,
        "text-channels.viewers.updated",
        1_500,
      );
      await new Promise((r) => setTimeout(r, 50));

      await wsRequest(ws, "v1", "text-channels", "setViewingChannel", {
        channel_id: GENERAL_CHANNEL_ID,
        viewing: true,
      });

      const events = await eventsPromise;
      expect(events.length).toBeGreaterThanOrEqual(1);
      const last = events[events.length - 1]!;
      expect(last["scope"]).toBe(`text-channels.channel.${GENERAL_CHANNEL_ID}.viewers`);
      const users = last["users"] as Array<Record<string, unknown>>;
      expect(users.some((u) => u["user_id"] === "user_1")).toBe(true);
    } finally {
      ws.close();
    }
  });

  test("setTyping(true) fans out typing.updated to current channel viewers", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);
    const viewer = await connectWs(bootResult.port, "valid-token");
    const typer = await connectWs(bootResult.port, "valid-token");

    try {
      await wsRequest(viewer, "v1", "text-channels", "setViewingChannel", {
        channel_id: GENERAL_CHANNEL_ID,
        viewing: true,
      });
      // Small delay for viewer presence to settle
      await new Promise((r) => setTimeout(r, 100));

      const typingEvents = collectEvents(
        viewer,
        "text-channels.typing.updated",
        1_500,
      );

      await wsRequest(typer, "t1", "text-channels", "setTyping", {
        channel_id: GENERAL_CHANNEL_ID,
        typing: true,
      });

      const received = await typingEvents;
      expect(received.length).toBeGreaterThanOrEqual(1);
      const last = received[received.length - 1]!;
      expect(last["scope"]).toBe(`text-channels.channel.${GENERAL_CHANNEL_ID}.typing`);
      const users = last["users"] as Array<Record<string, unknown>>;
      expect(users.length).toBeGreaterThanOrEqual(1);
      expect(typeof users[0]!["typing_until"]).toBe("number");
      // Regression: the payload must carry a non-empty display_name so the
      // frontend can render "Alice is typing…" without a follow-up lookup.
      expect(typeof users[0]!["display_name"]).toBe("string");
      expect((users[0]!["display_name"] as string).length).toBeGreaterThan(0);
    } finally {
      viewer.close();
      typer.close();
    }
  });

  test("setTyping(false) fans out typing.updated with empty users list", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);
    const viewer = await connectWs(bootResult.port, "valid-token");
    const typer = await connectWs(bootResult.port, "valid-token");

    try {
      await wsRequest(viewer, "v1", "text-channels", "setViewingChannel", {
        channel_id: GENERAL_CHANNEL_ID,
        viewing: true,
      });
      await wsRequest(typer, "t1", "text-channels", "setTyping", {
        channel_id: GENERAL_CHANNEL_ID,
        typing: true,
      });
      await new Promise((r) => setTimeout(r, 100));

      const stopEvents = collectEvents(
        viewer,
        "text-channels.typing.updated",
        1_500,
      );

      await wsRequest(typer, "t2", "text-channels", "setTyping", {
        channel_id: GENERAL_CHANNEL_ID,
        typing: false,
      });

      const received = await stopEvents;
      expect(received.length).toBeGreaterThanOrEqual(1);
      const last = received[received.length - 1]!;
      const users = last["users"] as Array<Record<string, unknown>>;
      expect(users.length).toBe(0);
    } finally {
      viewer.close();
      typer.close();
    }
  });

  test("setViewingThread joins thread viewers and fans out thread-scoped viewers.updated", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);
    const ws = await connectWs(bootResult.port, "valid-token");

    try {
      const root = (await wsRequest(ws, "r1", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "root",
      })) as Record<string, unknown>;

      const eventsPromise = collectEvents(
        ws,
        "text-channels.viewers.updated",
        1_500,
      );
      await new Promise((r) => setTimeout(r, 50));

      await wsRequest(ws, "vt1", "text-channels", "setViewingThread", {
        message_id: root["id"],
        viewing: true,
      });

      const received = await eventsPromise;
      const threadEvent = received.find(
        (e) => e["scope"] === `text-channels.thread.${String(root["id"])}.viewers`,
      );
      expect(threadEvent).toBeDefined();
      const users = threadEvent!["users"] as Array<Record<string, unknown>>;
      expect(users.some((u) => u["user_id"] === "user_1")).toBe(true);
    } finally {
      ws.close();
    }
  });

  test("typing.updated does not reach users who are not viewers of the scope", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);
    const typer = await connectWs(bootResult.port, "valid-token");
    const nonViewer = await connectWs(bootResult.port, "mod-token"); // different user, NOT viewing

    try {
      // Deliberately do not call setViewingChannel on nonViewer.
      const typingEvents = collectEvents(
        nonViewer,
        "text-channels.typing.updated",
        800,
      );

      await wsRequest(typer, "t1", "text-channels", "setTyping", {
        channel_id: GENERAL_CHANNEL_ID,
        typing: true,
      });

      const received = await typingEvents;
      expect(received.length).toBe(0);
    } finally {
      typer.close();
      nonViewer.close();
    }
  });

  // NOTE: Audience-cap coverage (typing.updated truncates past MAX_BROADCAST_AUDIENCE=100)
  // is not included here — it would need 100+ distinct WS connections from localhost,
  // which trips RATE_WS_CONNECT (10/60s/IP) well before saturation. Deferred to a
  // follow-up that lets the test harness relax the per-IP connect limit (or inject
  // presence entries bypassing WS entirely).

  test("migration 002 reconciliation UPDATE restores reply_count from desynced state", async () => {
    // Migration 002 ships a self-healing UPDATE that recomputes reply_count
    // from the actual reply rows. We can't simulate "pre-002 data" without
    // resetting migration state, but we CAN simulate the desync the
    // reconciliation fixes: zero out reply_count on a root with replies, run
    // the UPDATE, assert it's restored. Tests the SQL in the migration.
    const { deps, dataDir } = createBootDeps();
    bootResult = await boot(deps);

    let rootId = "";
    const ws = await connectWs(bootResult.port, "valid-token");
    try {
      const root = (await wsRequest(ws, "r", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "root",
      })) as Record<string, unknown>;
      rootId = root["id"] as string;
      for (let i = 0; i < 3; i++) {
        await wsRequest(ws, `reply-${i}`, "text-channels", "sendMessage", {
          channel_id: GENERAL_CHANNEL_ID,
          content: `reply ${i}`,
          parent_message_id: rootId,
        });
      }
    } finally {
      ws.close();
    }

    // Release the SQLite file so we can reopen it read-write. On Windows the
    // plugin subprocess needs a beat to release WAL file handles.
    await bootResult.shutdown();
    bootResult = null;
    await new Promise((r) => setTimeout(r, 150));

    const dbPath = join(dataDir, "plugins", "text-channels", "text-channels.db");
    const db = new Database(dbPath);
    try {
      db.exec("UPDATE messages SET reply_count = 0 WHERE parent_message_id IS NULL");
      const beforeRow = db
        .query<{ reply_count: number }, [string]>(
          "SELECT reply_count FROM messages WHERE id = ?",
        )
        .get(rootId);
      expect(beforeRow?.reply_count).toBe(0);

      // Re-apply the reconciliation UPDATE from migrations/002_add_threads.sql.
      db.exec(`
        UPDATE messages SET reply_count = (
          SELECT COUNT(*) FROM messages AS c WHERE c.parent_message_id = messages.id
        ) WHERE parent_message_id IS NULL
      `);

      const afterRow = db
        .query<{ reply_count: number }, [string]>(
          "SELECT reply_count FROM messages WHERE id = ?",
        )
        .get(rootId);
      expect(afterRow?.reply_count).toBe(3);
    } finally {
      db.close();
    }
  });

  // ---------------------------------------------------------------------------
  // File attachments (spec-26)
  // ---------------------------------------------------------------------------

  // PNG magic bytes — sniffMime will recognise this and the runtime will pick
  // a `.png` filename + `image/png` mime, which is what the sendMessage test
  // asserts against (instead of guessing octet-stream).
  const PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89,
  ]);

  async function uploadFile(
    port: number,
    token: string,
    slug: string,
    body: Uint8Array,
    filename: string,
  ): Promise<{ filename: string; size: number; mime: string }> {
    const res = await fetch(`http://localhost:${String(port)}/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Plugin": slug,
        "X-Filename": encodeURIComponent(filename),
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.byteLength),
      },
      body: new Blob([body as BlobPart]),
    });
    if (!res.ok) {
      throw new Error(`upload failed: ${String(res.status)} ${await res.text()}`);
    }
    return res.json() as Promise<{ filename: string; size: number; mime: string }>;
  }

  // Chunked-upload (spec-26 Amendment A) helper. Init → patch the body in
  // chunk_size-sized slices → finalize. Returns the finalize envelope plus
  // the per-step round-counts so the test can prove the chunked path ran.
  async function uploadFileChunked(
    port: number,
    token: string,
    slug: string,
    body: Uint8Array,
    filename: string,
  ): Promise<{ result: { filename: string; size: number; mime: string }; patchCount: number; uploadId: string }> {
    const initRes = await fetch(`http://localhost:${String(port)}/upload/init`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Plugin": slug,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ original_name: filename, total_bytes: body.byteLength }),
    });
    if (!initRes.ok) {
      throw new Error(`init failed: ${String(initRes.status)} ${await initRes.text()}`);
    }
    const init = (await initRes.json()) as {
      upload_id: string;
      chunk_size: number;
      expires_at: number;
      received_bytes: number;
    };
    const uploadId = init.upload_id;
    const chunkSize = init.chunk_size;

    let received = init.received_bytes;
    let patchCount = 0;
    while (received < body.byteLength) {
      const end = Math.min(received + chunkSize, body.byteLength);
      const slice = body.subarray(received, end);
      const patchRes = await fetch(
        `http://localhost:${String(port)}/upload/${uploadId}?offset=${String(received)}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Plugin": slug,
            "Content-Type": "application/octet-stream",
          },
          body: new Blob([slice as BlobPart]),
        },
      );
      if (!patchRes.ok) {
        throw new Error(`patch failed at offset ${String(received)}: ${String(patchRes.status)} ${await patchRes.text()}`);
      }
      const patch = (await patchRes.json()) as { received_bytes: number };
      received = patch.received_bytes;
      patchCount += 1;
    }

    const finalRes = await fetch(`http://localhost:${String(port)}/upload/${uploadId}/finalize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Plugin": slug,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (!finalRes.ok) {
      throw new Error(`finalize failed: ${String(finalRes.status)} ${await finalRes.text()}`);
    }
    const result = (await finalRes.json()) as { filename: string; size: number; mime: string };
    return { result, patchCount, uploadId };
  }

  test("sendMessage with attachment persists JSON and returns signed URL; GET /files serves it", async () => {
    const { deps, dataDir } = createBootDeps();
    bootResult = await boot(deps);

    const ws = await connectWs(bootResult.port, "valid-token");
    try {
      const uploaded = await uploadFile(
        bootResult.port,
        "valid-token",
        "text-channels",
        PNG_BYTES,
        "pixel.png",
      );
      expect(uploaded.filename).toMatch(/^[0-9a-f-]+\.png$/);
      expect(uploaded.mime).toBe("image/png");

      const sent = (await wsRequest(ws, "send_1", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "look",
        attachments: [
          { filename: uploaded.filename, original_name: "pixel.png", mime: "image/png" },
        ],
      })) as Record<string, unknown>;

      const wireAtt = (sent["attachments"] as Array<Record<string, unknown>>)[0]!;
      expect(wireAtt["filename"]).toBe(uploaded.filename);
      expect(wireAtt["original_name"]).toBe("pixel.png");
      expect(wireAtt["mime"]).toBe("image/png");
      expect(wireAtt["size"]).toBe(PNG_BYTES.byteLength);
      const url = String(wireAtt["url"]);
      expect(url.startsWith(`/files/text-channels/${uploaded.filename}?`)).toBe(true);
      expect(url).toContain("t=");
      expect(url).toContain("exp=");
      expect(url).toContain("u=user_1");

      // DB row stores attachments as JSON, no url field.
      const dbPath = join(dataDir, "plugins", "text-channels", "text-channels.db");
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .query<{ attachments: string | null }, []>(
            "SELECT attachments FROM messages WHERE attachments IS NOT NULL LIMIT 1",
          )
          .get();
        expect(row?.attachments).toBeTruthy();
        const parsed = JSON.parse(String(row!.attachments)) as Array<Record<string, unknown>>;
        expect(parsed[0]!["filename"]).toBe(uploaded.filename);
        expect(parsed[0]!["url"]).toBeUndefined();
      } finally {
        db.close();
      }

      // Signed URL actually serves the bytes back.
      const fileRes = await fetch(`http://localhost:${String(bootResult.port)}${url}`);
      expect(fileRes.status).toBe(200);
      expect(fileRes.headers.get("content-type")).toContain("image/png");
      const served = new Uint8Array(await fileRes.arrayBuffer());
      expect(served.byteLength).toBe(PNG_BYTES.byteLength);
    } finally {
      ws.close();
    }
  });

  test("sendMessage rejects unknown attachment filename", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);

    const ws = await connectWs(bootResult.port, "valid-token");
    try {
      await expect(
        wsRequest(ws, "send_1", "text-channels", "sendMessage", {
          channel_id: GENERAL_CHANNEL_ID,
          content: "x",
          attachments: [
            { filename: "deadbeef-1234-5678-9abc-deadbeefdead.png", original_name: "x.png" },
          ],
        }),
      ).rejects.toThrow(/ATTACHMENT_NOT_FOUND/);
    } finally {
      ws.close();
    }
  });

  test("sendMessage rejects path-traversal-shaped filename", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);

    const ws = await connectWs(bootResult.port, "valid-token");
    try {
      await expect(
        wsRequest(ws, "send_1", "text-channels", "sendMessage", {
          channel_id: GENERAL_CHANNEL_ID,
          content: "x",
          attachments: [{ filename: "../etc/passwd", original_name: "passwd" }],
        }),
      ).rejects.toThrow(/ATTACHMENT_INVALID_FILENAME/);
    } finally {
      ws.close();
    }
  });

  test("sendMessage permits empty content when attachments exist", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);

    const ws = await connectWs(bootResult.port, "valid-token");
    try {
      const uploaded = await uploadFile(
        bootResult.port,
        "valid-token",
        "text-channels",
        PNG_BYTES,
        "ok.png",
      );

      const sent = (await wsRequest(ws, "send_1", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "",
        attachments: [
          { filename: uploaded.filename, original_name: "ok.png", mime: "image/png" },
        ],
      })) as Record<string, unknown>;
      expect((sent["attachments"] as unknown[]).length).toBe(1);
    } finally {
      ws.close();
    }
  });

  test("sendMessage rejects fully-empty message (no content, no attachments)", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);

    const ws = await connectWs(bootResult.port, "valid-token");
    try {
      await expect(
        wsRequest(ws, "send_empty", "text-channels", "sendMessage", {
          channel_id: GENERAL_CHANNEL_ID,
          content: "",
        }),
      ).rejects.toThrow(/EMPTY_MESSAGE/);
    } finally {
      ws.close();
    }
  });

  test("getMessages mints fresh signed URLs per requesting user", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);

    const sender = await connectWs(bootResult.port, "valid-token");
    const otherViewer = await connectWs(bootResult.port, "user-bob-token");
    try {
      const uploaded = await uploadFile(
        bootResult.port,
        "valid-token",
        "text-channels",
        PNG_BYTES,
        "shared.png",
      );

      await wsRequest(sender, "send_1", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "share",
        attachments: [{ filename: uploaded.filename, original_name: "shared.png" }],
      });

      const fromSender = (await wsRequest(sender, "g1", "text-channels", "getMessages", {
        channel_id: GENERAL_CHANNEL_ID,
      })) as unknown as Array<Record<string, unknown>>;
      const fromBob = (await wsRequest(otherViewer, "g2", "text-channels", "getMessages", {
        channel_id: GENERAL_CHANNEL_ID,
      })) as unknown as Array<Record<string, unknown>>;

      const senderUrl = String(((fromSender[0]!["attachments"] as Array<Record<string, unknown>>)[0]!["url"]));
      const bobUrl = String(((fromBob[0]!["attachments"] as Array<Record<string, unknown>>)[0]!["url"]));
      expect(senderUrl).toContain("u=user_1");
      expect(bobUrl).toContain("u=user_bob");
      // Bound to different principals, so the signatures differ.
      expect(senderUrl).not.toBe(bobUrl);
    } finally {
      sender.close();
      otherViewer.close();
    }
  });

  test("chunked upload (spec-26 Amendment A) integrates with sendMessage end-to-end", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);

    // 12 MiB body — large enough to span 2 chunks at the runtime's default
    // 8 MiB chunk_size, but small enough to keep the test under a second.
    const TOTAL = 12 * 1024 * 1024;
    const body = new Uint8Array(TOTAL);
    // PNG magic prefix so the runtime's sniffer picks image/png + .png.
    body.set(PNG_BYTES, 0);

    const ws = await connectWs(bootResult.port, "valid-token");
    try {
      const { result, patchCount } = await uploadFileChunked(
        bootResult.port,
        "valid-token",
        "text-channels",
        body,
        "big.png",
      );
      // 12 MiB / 8 MiB chunk = exactly 2 PATCH rounds. Confirms the chunked
      // path actually chunked rather than handing the whole body in one shot.
      expect(patchCount).toBe(2);
      expect(result.filename).toMatch(/^[0-9a-f-]+\.png$/);
      expect(result.size).toBe(TOTAL);
      expect(result.mime).toBe("image/png");

      const sent = (await wsRequest(ws, "send_chunked", "text-channels", "sendMessage", {
        channel_id: GENERAL_CHANNEL_ID,
        content: "chunked",
        attachments: [
          { filename: result.filename, original_name: "big.png", mime: "image/png" },
        ],
      })) as Record<string, unknown>;

      const wireAtt = (sent["attachments"] as Array<Record<string, unknown>>)[0]!;
      expect(wireAtt["filename"]).toBe(result.filename);
      expect(wireAtt["size"]).toBe(TOTAL);
      const url = String(wireAtt["url"]);
      expect(url.startsWith(`/files/text-channels/${result.filename}?`)).toBe(true);

      // The freshly assembled file is served by the existing /files handler.
      const fileRes = await fetch(`http://localhost:${String(bootResult.port)}${url}`);
      expect(fileRes.status).toBe(200);
      expect(fileRes.headers.get("Content-Type")).toBe("image/png");
      const fetched = new Uint8Array(await fileRes.arrayBuffer());
      expect(fetched.byteLength).toBe(TOTAL);
      // First 8 bytes must match the PNG magic we wrote at offset 0.
      for (let i = 0; i < PNG_BYTES.length; i++) {
        expect(fetched[i]).toBe(PNG_BYTES[i]);
      }
    } finally {
      ws.close();
    }
  }, 30000);
});
