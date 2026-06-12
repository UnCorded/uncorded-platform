import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "../api/types";

// Full reconnect-timer behavior (disconnect cancels a pending
// scheduleReconnect timer; WS close-code 4003 funnels through purgeServer)
// requires real WS traffic and is covered by the manual QA section of the
// server-lifecycle plan. These tests lock the exported surface and the
// typed-error branches in openConnection so a refactor can't silently
// remove them.

const getServerToken =
  mock<(id: string) => Promise<{ token: string; expires_at: number; tunnel_url: string | null }>>();
const purgeServer = mock<(id: string, reason: string) => Promise<void>>();
// Hoisted token-cache spies so tests can assert on them (the reconnect-healing
// regression below checks clearToken fires on a never-opened close).
const storeToken = mock();
const clearToken = mock();

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static autoOpen = false; // when true, ctor auto-fires "open" on next microtask
  binaryType = "arraybuffer";
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  #listeners = new Map<string, Array<(ev: Event) => void>>();
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.autoOpen) {
      // Schedule an open right after construction so connect()'s openPromise
      // resolves and the test can move on to driving onclose.
      queueMicrotask(() => this.fireOpen());
    }
  }
  addEventListener(type: string, listener: (ev: Event) => void): void {
    let arr = this.#listeners.get(type);
    if (!arr) { arr = []; this.#listeners.set(type, arr); }
    arr.push(listener);
  }
  send(): void {}
  close(): void {}
  fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    const ev = new Event("open");
    this.onopen?.(ev);
    for (const fn of this.#listeners.get("open") ?? []) fn(ev);
  }
  fireClose(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    const ev = { code, reason: "", wasClean: true } as CloseEvent;
    this.onclose?.(ev);
    for (const fn of this.#listeners.get("close") ?? []) fn(ev);
  }
}

let wsModule: typeof import("./ws");

beforeAll(async () => {
  // Preserve real module exports on top of the spy override so sibling test
  // files that load later don't see a stripped-down surface. Bun's
  // mock.module is process-wide and sticky — see server-purge.test.ts for
  // the same pattern.
  const realCentral = await import("@/api/central");
  const realPurge = await import("@/lib/server-purge");
  const realTokens = await import("@/lib/tokens");
  await mock.module("@/api/central", () => ({ ...realCentral, getServerToken }));
  await mock.module("@/lib/server-purge", () => ({ ...realPurge, purgeServer }));
  await mock.module("./server-purge", () => ({ ...realPurge, purgeServer }));
  await mock.module("@/lib/tokens", () => ({
    ...realTokens,
    storeToken,
    clearToken,
  }));
  // Swap the global WebSocket so openConnection doesn't try to dial a real host.
  (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
  wsModule = await import("./ws");
});

beforeEach(() => {
  getServerToken.mockReset();
  purgeServer.mockReset();
  // Safe default: any caller that didn't program an explicit response gets a
  // rejection, which routes through the catch branch in openConnectionInner
  // instead of resolving to `undefined` and crashing on `tokenData.token`.
  // mock.module is process-wide and sticks after this file's tests finish; a
  // leaked reconnect timer firing during a sibling test would otherwise
  // corrupt that test's outcome with an unhandled rejection.
  getServerToken.mockImplementation(() =>
    Promise.reject(new ApiError("MOCK_DEFAULT", "getServerToken called without explicit mock", 500)),
  );
  FakeWebSocket.instances = [];
  FakeWebSocket.autoOpen = false;
  storeToken.mockReset();
  clearToken.mockReset();
});

afterAll(() => {
  // Pin the safe default for the rest of the test process. mock.module
  // installed in beforeAll persists across files; without a default, sibling
  // tests that incidentally trigger `central.getServerToken` (e.g. via a
  // leaked reconnect timer) would resolve to undefined and crash on
  // `tokenData.token` at ws.ts:476, blaming whichever test happens to be
  // running.
  getServerToken.mockImplementation(() =>
    Promise.reject(new ApiError("MOCK_DEFAULT", "getServerToken called from leaked timer after ws.test.ts", 500)),
  );
});

function makeServer(id = "srv-err") {
  return {
    id,
    name: "srv",
    description: null,
    visibility: "public" as const,
    owner_id: "owner",
    tunnel_url: "https://tunnel.example",
    tunnel_state: null,
    runtime_version: "1.0.0",
    connected_users: 0,
    plugin_count: 0,
    is_online: true,
    last_heartbeat_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

// Give the dynamic import("./server-purge") in ws.ts a chance to resolve.
// Fired-and-forgotten inside the catch, so awaiting connect() alone isn't
// enough. A few microtasks + a short macrotask covers dynamic import + .then.
async function flushPurgeImport(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 30));
}

describe("abortReconnect", () => {
  test("is a no-op when there is no pending timer", () => {
    expect(() => wsModule.abortReconnect("srv-nonexistent")).not.toThrow();
  });
});

describe("disconnect", () => {
  test("is a no-op when the connection was never opened", () => {
    expect(() => wsModule.disconnect("srv-never-connected")).not.toThrow();
  });
});

describe("openConnection error branches", () => {
  test("404 from getServerToken → purgeServer(central-gone), no reconnect", async () => {
    getServerToken.mockRejectedValueOnce(new ApiError("NOT_FOUND", "server gone", 404));
    const server = makeServer("srv-404");
    await wsModule.connect(server);
    await flushPurgeImport();
    expect(purgeServer).toHaveBeenCalledTimes(1);
    expect(purgeServer).toHaveBeenCalledWith("srv-404", "central-gone");
    // Clean up any straggler timer (none expected since we didn't schedule).
    wsModule.abortReconnect("srv-404");
  });

  test("403 from getServerToken → purgeServer(banned), no reconnect", async () => {
    getServerToken.mockRejectedValueOnce(new ApiError("FORBIDDEN", "banned", 403));
    const server = makeServer("srv-403");
    await wsModule.connect(server);
    await flushPurgeImport();
    expect(purgeServer).toHaveBeenCalledTimes(1);
    expect(purgeServer).toHaveBeenCalledWith("srv-403", "banned");
    wsModule.abortReconnect("srv-403");
  });

  test("500 from getServerToken → no purge (reconnect is scheduled for retry)", async () => {
    getServerToken.mockRejectedValueOnce(new ApiError("SERVER_ERROR", "boom", 500));
    const server = makeServer("srv-500");
    await wsModule.connect(server);
    await flushPurgeImport();
    expect(purgeServer).not.toHaveBeenCalled();
    // Cancel the scheduled reconnect so the timer doesn't leak into later tests.
    wsModule.abortReconnect("srv-500");
  });

  test("non-ApiError (network) from getServerToken → no purge", async () => {
    getServerToken.mockRejectedValueOnce(new TypeError("network down"));
    const server = makeServer("srv-net");
    await wsModule.connect(server);
    await flushPurgeImport();
    expect(purgeServer).not.toHaveBeenCalled();
    wsModule.abortReconnect("srv-net");
  });
});

describe("expired-tunnel gate (WS4)", () => {
  test("connect() refuses to dial or mint a token when tunnel_state is expired", async () => {
    // No getServerToken mock is programmed; if the gate failed to short-circuit,
    // the beforeEach default rejection would route through the catch and we'd
    // see a reconnect scheduled. The gate must return before the token fetch.
    const server = { ...makeServer("srv-expired"), tunnel_state: "expired" as const };
    await wsModule.connect(server);
    expect(FakeWebSocket.instances.length).toBe(0);
    expect(getServerToken).not.toHaveBeenCalled();
    // Defensive: nothing should have been scheduled, but clear just in case so
    // a regression doesn't leak a timer into a sibling test.
    wsModule.abortReconnect("srv-expired");
  });

  test("forceReconnect() refuses to dial when tunnel_state is expired", async () => {
    const server = { ...makeServer("srv-expired-force"), tunnel_state: "expired" as const };
    await wsModule.forceReconnect(server);
    expect(FakeWebSocket.instances.length).toBe(0);
    expect(getServerToken).not.toHaveBeenCalled();
    wsModule.abortReconnect("srv-expired-force");
  });

  test("connect() still dials when tunnel_state is demo (not expired)", async () => {
    getServerToken.mockResolvedValueOnce({
      token: "fake-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      tunnel_url: null,
    });
    FakeWebSocket.autoOpen = true;
    const server = { ...makeServer("srv-demo"), tunnel_state: "demo" as const };
    await wsModule.connect(server);
    expect(FakeWebSocket.instances.length).toBe(1);
    wsModule.disconnect("srv-demo");
  });
});

describe("forceReconnect (PR-TR5)", () => {
  test("no tunnel_url anywhere → no dial, cached token dropped for a fresh re-mint", async () => {
    // The URL is a capability resolved by the token mint now, so a missing
    // tunnel_url no longer early-returns — it mints, and only bails (clearing
    // the cache so the NEXT attempt re-mints and re-resolves) when the mint
    // comes back URL-less too.
    getServerToken.mockResolvedValueOnce({
      token: "fake-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      tunnel_url: null,
    });
    const server = { ...makeServer("srv-no-tunnel"), tunnel_url: null };
    await wsModule.forceReconnect(server);
    expect(FakeWebSocket.instances.length).toBe(0);
    expect(clearToken).toHaveBeenCalledWith("srv-no-tunnel");
  });

  test("opens a fresh connection when none exists", async () => {
    getServerToken.mockResolvedValueOnce({
      token: "fake-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      tunnel_url: null,
    });
    FakeWebSocket.autoOpen = true;
    const server = makeServer("srv-force-open");
    await wsModule.forceReconnect(server);
    expect(FakeWebSocket.instances.length).toBe(1);
    wsModule.disconnect("srv-force-open");
  });

  test("no-op when an OPEN connection already exists", async () => {
    getServerToken.mockResolvedValueOnce({
      token: "fake-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      tunnel_url: null,
    });
    FakeWebSocket.autoOpen = true;
    const server = makeServer("srv-already-open");
    await wsModule.connect(server);
    const before = FakeWebSocket.instances.length;
    await wsModule.forceReconnect(server);
    expect(FakeWebSocket.instances.length).toBe(before);
    wsModule.disconnect("srv-already-open");
  });

  test("cancels a pending reconnect timer before opening a fresh socket", async () => {
    // Drive a 500 to schedule a reconnect, then forceReconnect must clear it.
    getServerToken.mockRejectedValueOnce(new ApiError("SERVER_ERROR", "boom", 500));
    const server = makeServer("srv-force-timer");
    await wsModule.connect(server);
    await flushPurgeImport();
    // A reconnect timer is now pending. forceReconnect should clear it (we
    // can't directly observe the timer, but the function MUST NOT throw and
    // MUST not leave the pending timer to fire after the test ends).
    getServerToken.mockResolvedValueOnce({
      token: "fake-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      tunnel_url: null,
    });
    FakeWebSocket.autoOpen = true;
    await wsModule.forceReconnect(server);
    wsModule.disconnect("srv-force-timer");
    wsModule.abortReconnect("srv-force-timer");
  });
});

describe("WS close-code branches", () => {
  async function connectAndGetSocket(serverId: string): Promise<FakeWebSocket> {
    getServerToken.mockResolvedValueOnce({
      token: "fake-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      tunnel_url: null,
    });
    FakeWebSocket.autoOpen = true;
    const server = makeServer(serverId);
    await wsModule.connect(server);
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error("no FakeWebSocket created");
    return ws;
  }

  test("4003 close → purgeServer(banned), no reconnect", async () => {
    const ws = await connectAndGetSocket("srv-4003");
    ws.fireClose(4003);
    await flushPurgeImport();
    expect(purgeServer).toHaveBeenCalledTimes(1);
    expect(purgeServer).toHaveBeenCalledWith("srv-4003", "banned");
    wsModule.abortReconnect("srv-4003");
  });

  test("4004 close → does NOT purge; reconnect is scheduled", async () => {
    const ws = await connectAndGetSocket("srv-4004");
    ws.fireClose(4004);
    await flushPurgeImport();
    expect(purgeServer).not.toHaveBeenCalled();
    // A reconnect is pending — clear it so it doesn't leak across tests.
    wsModule.abortReconnect("srv-4004");
  });

  test("4001 close → no purge; reconnect is scheduled (auth-timeout / token-replay / re-sync)", async () => {
    const ws = await connectAndGetSocket("srv-4001");
    ws.fireClose(4001);
    await flushPurgeImport();
    expect(purgeServer).not.toHaveBeenCalled();
    // 4001 used to be terminal ("server re-establishes on its own"). It is now
    // recoverable: the runtime sends 4001 for "Token already used" (JTI replay
    // after a successful auth + reconnect), so the client must mint a fresh
    // token and try again rather than giving up.
    wsModule.abortReconnect("srv-4001");
  });

  test("unknown close code (1006) → no purge; reconnect is scheduled", async () => {
    const ws = await connectAndGetSocket("srv-1006");
    ws.fireClose(1006);
    await flushPurgeImport();
    expect(purgeServer).not.toHaveBeenCalled();
    wsModule.abortReconnect("srv-1006");
  });
});

// CV-FOUND-6: the projected render-tree frame already passes ServerMessageSchema
// but the dispatcher gained a dedicated branch + subscriber set. These drive the
// inbound dispatcher directly (a JSON text frame through ws.onmessage) to prove
// the new branch routes, and — critically — that the legacy session-push family
// (state/cursor/event) still dispatches and that projected frames stay isolated
// from it.
describe("co-view.render-tree.projected routing (CV-FOUND-6)", () => {
  async function openAuthed(serverId: string): Promise<FakeWebSocket> {
    getServerToken.mockResolvedValueOnce({
      token: "fake-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      tunnel_url: null,
    });
    FakeWebSocket.autoOpen = true;
    await wsModule.connect(makeServer(serverId));
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error("no FakeWebSocket created");
    // Complete the auth handshake so the connection is fully live.
    ws.onmessage?.({ data: JSON.stringify({ type: "auth.result", ok: true }) } as MessageEvent);
    return ws;
  }

  function deliver(ws: FakeWebSocket, frame: unknown): void {
    ws.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }

  function projectedFrame(sessionId: string) {
    return {
      type: "co-view.render-tree.projected",
      session_id: sessionId,
      frame: {
        surfaceId: sessionId,
        root: { id: "root", kind: "element", box: { x: 0, y: 0, width: 1, height: 1 } },
      },
    };
  }
  function stateFrame(sessionId: string) {
    return { type: "co-view.state", session_id: sessionId, seq: 1, diff: {}, replay: "safe", ts: 0 };
  }
  function cursorFrame(sessionId: string) {
    return { type: "co-view.cursor", session_id: sessionId, x: 1, y: 2, state: "idle", ts: 0 };
  }
  function eventFrame(sessionId: string) {
    return { type: "co-view.event", session_id: sessionId, kind: "nav.route_change", payload: {}, replay: "safe", ts: 0 };
  }

  test("a projected frame reaches an onCoViewRenderTreeProjected subscriber", async () => {
    const ws = await openAuthed("srv-cvproj");
    const received: Array<{ session_id: string }> = [];
    const unsub = wsModule.onCoViewRenderTreeProjected("srv-cvproj", (m) => received.push(m));
    deliver(ws, projectedFrame("sess-1"));
    expect(received).toHaveLength(1);
    expect(received[0]?.session_id).toBe("sess-1");
    unsub();
    wsModule.disconnect("srv-cvproj");
  });

  test("legacy co-view.state/cursor/event still dispatch; projected stays isolated", async () => {
    const ws = await openAuthed("srv-cvlegacy");
    const seen: string[] = [];
    const unsubSession = wsModule.onCoViewSessionMessage(
      "srv-cvlegacy",
      () => true,
      (m) => seen.push(m.type),
    );
    deliver(ws, stateFrame("s"));
    deliver(ws, cursorFrame("s"));
    deliver(ws, eventFrame("s"));
    expect(seen).toEqual(["co-view.state", "co-view.cursor", "co-view.event"]);

    // A projected frame must NOT leak into the legacy session family, and must
    // reach the dedicated projected subscriber instead.
    const projected: unknown[] = [];
    const unsubProj = wsModule.onCoViewRenderTreeProjected("srv-cvlegacy", (m) => projected.push(m));
    deliver(ws, projectedFrame("s"));
    expect(seen).toEqual(["co-view.state", "co-view.cursor", "co-view.event"]);
    expect(projected).toHaveLength(1);

    unsubSession();
    unsubProj();
    wsModule.disconnect("srv-cvlegacy");
  });
});

// Reconnect healing (membership branch): tunnel_url rides only with the token
// mint, so (a) a mint that returns a URL must be the one dialed — even when
// the caller's snapshot is stale — and (b) a socket that dies without ever
// opening must drop the cached token so the next attempt re-mints and
// re-resolves the URL instead of redialing a dead address until expiry.
describe("reconnect healing — mint-resolved URLs", () => {
  test("dials the minted tunnel_url, not the caller's stale snapshot", async () => {
    getServerToken.mockResolvedValueOnce({
      token: "fake-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      tunnel_url: "https://fresh.example",
    });
    FakeWebSocket.autoOpen = true;
    const server = { ...makeServer("srv-heal-mint"), tunnel_url: "https://stale.example" };
    await wsModule.connect(server);
    const ws = FakeWebSocket.instances.at(-1);
    expect(ws?.url).toBe("wss://fresh.example/ws");
    wsModule.disconnect("srv-heal-mint");
  });

  test("never-opened close clears the cached token and schedules a reconnect", async () => {
    getServerToken.mockResolvedValueOnce({
      token: "fake-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      tunnel_url: "https://dead.example",
    });
    FakeWebSocket.autoOpen = false; // dial never reaches open
    const server = makeServer("srv-heal-close");
    const connecting = wsModule.connect(server);
    // connect() awaits the open promise, which also resolves on close.
    await Promise.resolve();
    const ws = FakeWebSocket.instances.at(-1);
    expect(ws).toBeDefined();
    clearToken.mockClear();
    ws!.fireClose(1006);
    await connecting;
    // The token cache must be dropped so the next attempt re-mints (and with
    // it re-resolves the tunnel URL from Central).
    expect(clearToken).toHaveBeenCalledWith("srv-heal-close");
    wsModule.abortReconnect("srv-heal-close");
  });

  test("a close AFTER a successful open does not take the never-opened branch", async () => {
    getServerToken.mockResolvedValueOnce({
      token: "fake-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      tunnel_url: null,
    });
    FakeWebSocket.autoOpen = true;
    const server = makeServer("srv-heal-opened");
    await wsModule.connect(server);
    const ws = FakeWebSocket.instances.at(-1);
    clearToken.mockClear();
    // Pre-auth close on an OPENED socket (e.g. network reset mid-handshake):
    // the cache survives so a transient blip doesn't burn a mint.
    ws!.fireClose(1006);
    expect(clearToken).not.toHaveBeenCalled();
    wsModule.abortReconnect("srv-heal-opened");
  });
});
