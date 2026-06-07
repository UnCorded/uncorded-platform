import { describe, expect, test } from "bun:test";
import { ParticipantTracker, PendingKickMap } from "./cascade-state";

describe("ParticipantTracker", () => {
  test("add and channelsForUser are idempotent and return all rooms", () => {
    const tracker = new ParticipantTracker();
    tracker.add("ch-a", "user-1");
    tracker.add("ch-a", "user-1"); // dup
    tracker.add("ch-b", "user-1");
    tracker.add("ch-a", "user-2");

    expect(tracker.channelsForUser("user-1").sort()).toEqual(["ch-a", "ch-b"]);
    expect(tracker.channelsForUser("user-2")).toEqual(["ch-a"]);
    expect(tracker.channelsForUser("user-3")).toEqual([]);
  });

  test("remove deletes user but keeps room while others remain", () => {
    const tracker = new ParticipantTracker();
    tracker.add("ch-a", "user-1");
    tracker.add("ch-a", "user-2");
    tracker.remove("ch-a", "user-1");

    expect(tracker.channelsForUser("user-1")).toEqual([]);
    expect(tracker.channelsForUser("user-2")).toEqual(["ch-a"]);
    expect(tracker.size()).toBe(1);
  });

  test("remove cleans up empty rooms", () => {
    const tracker = new ParticipantTracker();
    tracker.add("ch-a", "user-1");
    tracker.remove("ch-a", "user-1");
    expect(tracker.size()).toBe(0);
    // Removing again is a no-op.
    tracker.remove("ch-a", "user-1");
    expect(tracker.size()).toBe(0);
  });

  test("removeRoom drops every member", () => {
    const tracker = new ParticipantTracker();
    tracker.add("ch-a", "user-1");
    tracker.add("ch-a", "user-2");
    tracker.removeRoom("ch-a");
    expect(tracker.channelsForUser("user-1")).toEqual([]);
    expect(tracker.channelsForUser("user-2")).toEqual([]);
    expect(tracker.size()).toBe(0);
  });
});

describe("PendingKickMap", () => {
  test("stage then consume returns the staged reason and removes it", () => {
    const map = new PendingKickMap();
    map.stage("ch-a", "user-1", "server_ban");
    expect(map.consume("ch-a", "user-1")).toBe("server_ban");
    // Second consume returns null — the entry was deleted.
    expect(map.consume("ch-a", "user-1")).toBeNull();
  });

  test("consume returns null for unknown (channel,user)", () => {
    const map = new PendingKickMap();
    expect(map.consume("ch-x", "user-x")).toBeNull();
  });

  test("re-stage refreshes reason and TTL", () => {
    const map = new PendingKickMap();
    map.stage("ch-a", "user-1", "server_kick");
    map.stage("ch-a", "user-1", "server_ban");
    expect(map.consume("ch-a", "user-1")).toBe("server_ban");
  });

  test("expired entries are evicted on consume", () => {
    let now = 1_000_000;
    const map = new PendingKickMap({ ttlMs: 1000, now: () => now });
    map.stage("ch-a", "user-1", "server_ban");
    now += 1500; // past TTL
    expect(map.consume("ch-a", "user-1")).toBeNull();
    expect(map.size()).toBe(0);
  });

  test("size sweeps expired entries before reporting", () => {
    let now = 1_000_000;
    const map = new PendingKickMap({ ttlMs: 1000, now: () => now });
    map.stage("ch-a", "user-1", "server_ban");
    map.stage("ch-b", "user-2", "server_kick");
    expect(map.size()).toBe(2);
    now += 1500;
    expect(map.size()).toBe(0);
  });

  test("cancel removes a single staged entry without consuming", () => {
    const map = new PendingKickMap();
    map.stage("ch-a", "user-1", "server_ban");
    map.cancel("ch-a", "user-1");
    expect(map.consume("ch-a", "user-1")).toBeNull();
  });

  test("cancelUser drops every staged entry for the user across rooms", () => {
    const map = new PendingKickMap();
    map.stage("ch-a", "user-1", "server_ban");
    map.stage("ch-b", "user-1", "server_ban");
    map.stage("ch-a", "user-2", "server_ban");
    map.cancelUser("user-1");
    expect(map.consume("ch-a", "user-1")).toBeNull();
    expect(map.consume("ch-b", "user-1")).toBeNull();
    // user-2's staged kick is preserved.
    expect(map.consume("ch-a", "user-2")).toBe("server_ban");
  });
});
