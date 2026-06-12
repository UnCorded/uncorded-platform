import { describe, expect, test } from "bun:test";
import type { Server } from "../api/types";

// No mock.module here on purpose: bun's module mocks are process-wide and
// sticky, so stubbing stores/servers would poison stores/servers.test.ts in
// the same worker. The real import chain is test-safe (api/central's BASE_URL
// only touches window under import.meta.env.DEV, which bun leaves unset).

function makeServer(id: string, name: string): Server {
  return {
    id,
    name,
    description: null,
    visibility: "public",
    owner_id: "owner",
    tunnel_url: null,
    tunnel_state: null,
    runtime_version: null,
    connected_users: 0,
    plugin_count: 0,
    is_online: false,
    last_heartbeat_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const A = makeServer("11111111-2222-3333-4444-555555555555", "UnCorded");
const B = makeServer("66666666-7777-8888-9999-aaaaaaaaaaaa", "Game Night!");
const B2 = makeServer("bbbbbbbb-cccc-dddd-eeee-ffffffffffff", "game night");

describe("slugifyServerName", () => {
  test("lowercases, hyphenates, trims, caps length", async () => {
    const { slugifyServerName } = await import("./server-route");
    expect(slugifyServerName("UnCorded")).toBe("uncorded");
    expect(slugifyServerName("Game Night!")).toBe("game-night");
    expect(slugifyServerName("  --weird   name--  ")).toBe("weird-name");
    expect(slugifyServerName("日本語のみ")).toBe("");
    expect(slugifyServerName("x".repeat(100)).length).toBeLessThanOrEqual(48);
  });
});

describe("serverRouteSegment", () => {
  test("plain slug when unique; short-id suffix on collision", async () => {
    const { serverRouteSegment } = await import("./server-route");
    expect(serverRouteSegment(A, [A, B])).toBe("uncorded");
    expect(serverRouteSegment(B, [A, B, B2])).toBe("game-night--66666666");
    expect(serverRouteSegment(B2, [A, B, B2])).toBe("game-night--bbbbbbbb");
  });

  test("unslugifiable name falls back to a short-id segment", async () => {
    const { serverRouteSegment } = await import("./server-route");
    const emoji = makeServer("12345678-aaaa-bbbb-cccc-dddddddddddd", "日本語");
    expect(serverRouteSegment(emoji, [emoji])).toBe("server--12345678");
  });
});

describe("resolveServerRoute", () => {
  test("round-trips every segment shape back to its server", async () => {
    const { serverRouteSegment, resolveServerRoute } = await import("./server-route");
    const all = [A, B, B2];
    for (const s of all) {
      expect(resolveServerRoute(serverRouteSegment(s, all), all)).toBe(s.id);
    }
  });

  test("accepts a raw uuid; rejects unknown ids", async () => {
    const { resolveServerRoute } = await import("./server-route");
    expect(resolveServerRoute(A.id, [A, B])).toBe(A.id);
    expect(
      resolveServerRoute("99999999-9999-9999-9999-999999999999", [A, B]),
    ).toBeNull();
  });

  test("ambiguous bare slug resolves to nothing (never guesses)", async () => {
    const { resolveServerRoute } = await import("./server-route");
    expect(resolveServerRoute("game-night", [A, B, B2])).toBeNull();
    // But a unique bare slug still works even when written pre-collision.
    expect(resolveServerRoute("game-night", [A, B])).toBe(B.id);
  });

  test("dead slugs and junk resolve to null", async () => {
    const { resolveServerRoute } = await import("./server-route");
    expect(resolveServerRoute("departed-server", [A])).toBeNull();
    expect(resolveServerRoute("game-night--00000000", [A, B])).toBeNull();
  });
});
