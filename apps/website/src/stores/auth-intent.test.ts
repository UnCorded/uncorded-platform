import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

// auth-intent imports stores/auth only for sessionExpired; mock it so this
// test doesn't drag in the api/central → window.location module chain.
const sessionExpired = mock<(reason: string) => void>();

let intents: typeof import("./auth-intent");
let ApiError: typeof import("../api/types").ApiError;

beforeAll(async () => {
  await mock.module("./auth", () => ({ sessionExpired }));
  intents = await import("./auth-intent");
  ({ ApiError } = await import("../api/types"));
});

beforeEach(() => {
  sessionExpired.mockReset();
  intents.consumePendingIntent(); // clear any prior state
  intents.clearJoinTarget();
});

const SERVER_ID = "11111111-2222-3333-4444-555555555555";

describe("pending intent storage", () => {
  test("set → peek → consume; consume clears so it replays at most once", () => {
    intents.setPendingIntent({ action: "join", serverId: SERVER_ID });
    expect(intents.peekPendingIntent()).toEqual({ action: "join", serverId: SERVER_ID });

    const consumed = intents.consumePendingIntent();
    expect(consumed).toEqual({ action: "join", serverId: SERVER_ID });
    expect(intents.peekPendingIntent()).toBeNull();
    expect(intents.consumePendingIntent()).toBeNull();
  });
});

describe("parseJoinParam", () => {
  test("accepts a UUID, rejects junk and injection shapes", () => {
    expect(intents.parseJoinParam(SERVER_ID)).toBe(SERVER_ID);
    expect(intents.parseJoinParam(null)).toBeNull();
    expect(intents.parseJoinParam("")).toBeNull();
    expect(intents.parseJoinParam("not-a-uuid")).toBeNull();
    expect(intents.parseJoinParam(`${SERVER_ID}/extra`)).toBeNull();
    expect(intents.parseJoinParam("javascript:alert(1)")).toBeNull();
  });
});

describe("withAuthGate", () => {
  test("passes through the result when the action succeeds", async () => {
    const result = await intents.withAuthGate(
      { action: "join", serverId: SERVER_ID },
      async () => "ok",
    );
    expect(result).toBe("ok");
    expect(sessionExpired.mock.calls.length).toBe(0);
    expect(intents.peekPendingIntent()).toBeNull();
  });

  test("401 stashes the intent and surfaces AuthPage via sessionExpired", async () => {
    const result = await intents.withAuthGate(
      { action: "join", serverId: SERVER_ID },
      async () => {
        throw new ApiError("UNAUTHORIZED", "Authentication required", 401);
      },
    );
    expect(result).toBeNull();
    expect(sessionExpired.mock.calls.length).toBe(1);
    expect(intents.peekPendingIntent()).toEqual({ action: "join", serverId: SERVER_ID });
  });

  test("non-401 errors propagate untouched and stash nothing", async () => {
    await expect(
      intents.withAuthGate({ action: "join", serverId: SERVER_ID }, async () => {
        throw new ApiError("NOT_FOUND", "Server not found", 404);
      }),
    ).rejects.toThrow("Server not found");
    expect(sessionExpired.mock.calls.length).toBe(0);
    expect(intents.peekPendingIntent()).toBeNull();
  });
});

describe("joinTarget replay signal", () => {
  test("setJoinTarget / clearJoinTarget round-trip", () => {
    expect(intents.joinTarget()).toBeNull();
    intents.setJoinTarget(SERVER_ID);
    expect(intents.joinTarget()).toBe(SERVER_ID);
    intents.clearJoinTarget();
    expect(intents.joinTarget()).toBeNull();
  });
});
