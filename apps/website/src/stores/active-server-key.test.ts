// Regression: Central stopped returning tunnel_url in list/get responses —
// the URL is only revealed by the token mint inside ws.connect(), which
// hydrates the store via patchServer. The activeKey memos in sidebar.ts /
// membership.ts / permissions.ts / runtime-update.ts used to return null when
// tunnel_url was missing, so the connect-initiating effects never fired for a
// freshly-listed server: no connect → no mint → no URL → no connect
// (deadlock; "Server is not yet reachable" + every surface stuck loading).
// activeServerKey is now the single key derivation for those memos; these
// tests pin its contract.

import { describe, expect, test } from "bun:test";
import type { Server } from "../api/types";
import { activeServerKey, splitActiveServerKey } from "./active-server-key";

function makeServer(id: string, tunnelUrl: string | null): Server {
  return {
    id,
    name: "Test",
    description: null,
    visibility: "public",
    owner_id: "owner",
    tunnel_url: tunnelUrl,
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

describe("activeServerKey", () => {
  test("null when no server is active", () => {
    expect(activeServerKey(null, null)).toBeNull();
    expect(activeServerKey("srv-1", null)).toBeNull();
    expect(activeServerKey(null, makeServer("srv-1", null))).toBeNull();
  });

  test("non-null for a URL-less server — the connect effect must fire pre-hydration", () => {
    // The deadlock condition: server selected, tunnel_url not yet minted.
    // A null key here means connect() never runs and the URL never hydrates.
    const key = activeServerKey("srv-1", makeServer("srv-1", null));
    expect(key).toBe("srv-1|");
    expect(splitActiveServerKey(key!)).toEqual({ id: "srv-1", tunnelUrl: "" });
  });

  test("hydrating tunnel_url changes the key — effects re-fire to run HTTP loads", () => {
    const before = activeServerKey("srv-1", makeServer("srv-1", null));
    const after = activeServerKey(
      "srv-1",
      makeServer("srv-1", "https://hydrated.example"),
    );
    expect(after).not.toBe(before);
    expect(splitActiveServerKey(after!)).toEqual({
      id: "srv-1",
      tunnelUrl: "https://hydrated.example",
    });
  });

  test("unrelated field churn does not change the key (no connect loop)", () => {
    // The original reason these memos exist: onConnect's is_online patch must
    // not tear the effect down and re-run connect() into the rate limiter.
    const a = makeServer("srv-1", "https://t.example");
    const b = { ...a, is_online: false, connected_users: 7, name: "Renamed" };
    expect(activeServerKey("srv-1", a)).toBe(activeServerKey("srv-1", b)!);
  });

  test("round-trips a tunnel URL containing a pipe-free path and port", () => {
    const key = activeServerKey(
      "srv-2",
      makeServer("srv-2", "https://test.uncorded.app:8443/base"),
    );
    expect(splitActiveServerKey(key!)).toEqual({
      id: "srv-2",
      tunnelUrl: "https://test.uncorded.app:8443/base",
    });
  });
});
