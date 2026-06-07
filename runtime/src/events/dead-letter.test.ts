import { describe, expect, test } from "bun:test";
import { DeadLetterLog } from "./dead-letter";
import type { DeadLetterEntry, EventEnvelope } from "./types";

function makeEntry(overrides?: Partial<DeadLetterEntry>): DeadLetterEntry {
  const event: EventEnvelope = {
    topic: "test.topic",
    version: 1,
    id: `evt_${crypto.randomUUID()}`,
    ts: Date.now(),
    source_plugin: "test-plugin",
    payload: {},
  };
  return {
    event,
    subscriberPlugin: "subscriber",
    topicPattern: "test.*",
    failedAt: Date.now(),
    error: "delivery failed",
    ...overrides,
  };
}

describe("DeadLetterLog", () => {
  test("add and retrieve entries", () => {
    const log = new DeadLetterLog();
    const entry = makeEntry();
    log.add(entry);
    expect(log.size).toBe(1);
    expect(log.getEntries()[0]).toBe(entry);
  });

  test("entries beyond max evict oldest", () => {
    const log = new DeadLetterLog(3);
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ error: `error-${i}` }),
    );
    for (const e of entries) log.add(e);

    expect(log.size).toBe(3);
    const stored = log.getEntries();
    expect(stored[0]?.error).toBe("error-2");
    expect(stored[1]?.error).toBe("error-3");
    expect(stored[2]?.error).toBe("error-4");
  });

  test("TTL expiration prunes old entries on add", () => {
    const ttlMs = 1000;
    const log = new DeadLetterLog(100, ttlMs);

    // Add an entry "in the past"
    const old = makeEntry({ failedAt: Date.now() - 2000 });
    log.add(old);
    expect(log.size).toBe(1);

    // Adding a new entry triggers prune — old entry expires
    const fresh = makeEntry();
    log.add(fresh);
    expect(log.size).toBe(1);
    expect(log.getEntries()[0]).toBe(fresh);
  });

  test("explicit prune removes expired entries", () => {
    // Use a very short TTL so entries expire quickly
    const ttlMs = 1; // 1ms
    const log = new DeadLetterLog(100, ttlMs);

    // Add entries that are fresh *now* but will expire almost immediately
    log.add(makeEntry({ failedAt: Date.now() - 2 }));
    // First add: prune (nothing), insert. Second add: prune (first expired), insert.
    // After both adds, only one entry remains (the most recent).
    log.add(makeEntry({ failedAt: Date.now() - 2 }));

    // The remaining entry is also expired — prune should remove it
    const removed = log.prune();
    expect(removed).toBe(1);
    expect(log.size).toBe(0);
  });

  test("empty log returns empty array", () => {
    const log = new DeadLetterLog();
    expect(log.getEntries()).toEqual([]);
    expect(log.size).toBe(0);
  });

  test("mixed: some expired + over capacity", () => {
    const log = new DeadLetterLog(2, 500);

    // Two expired entries
    log.add(makeEntry({ failedAt: Date.now() - 1000, error: "old-1" }));
    log.add(makeEntry({ failedAt: Date.now() - 1000, error: "old-2" }));

    // Add a fresh entry — prune removes both expired, then inserts
    log.add(makeEntry({ error: "fresh" }));
    expect(log.size).toBe(1);
    expect(log.getEntries()[0]?.error).toBe("fresh");
  });
});
