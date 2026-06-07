import { describe, expect, test } from "bun:test";
import { JtiRevocationSet } from "./revocation";

describe("JtiRevocationSet", () => {
  test("new set has size 0", () => {
    const set = new JtiRevocationSet();
    expect(set.size).toBe(0);
  });

  test("add and check revocation", () => {
    const set = new JtiRevocationSet();
    set.add("jti-1");
    expect(set.isRevoked("jti-1")).toBe(true);
    expect(set.isRevoked("jti-2")).toBe(false);
    expect(set.size).toBe(1);
  });

  test("multiple JTIs tracked independently", () => {
    const set = new JtiRevocationSet();
    set.add("a");
    set.add("b");
    set.add("c");
    expect(set.size).toBe(3);
    expect(set.isRevoked("a")).toBe(true);
    expect(set.isRevoked("b")).toBe(true);
    expect(set.isRevoked("c")).toBe(true);
    expect(set.isRevoked("d")).toBe(false);
  });

  test("duplicate add is idempotent", () => {
    const set = new JtiRevocationSet();
    set.add("jti-1");
    set.add("jti-1");
    expect(set.size).toBe(1);
  });

  test("prune removes entries older than max token lifetime", () => {
    const set = new JtiRevocationSet();

    // Manually insert an old entry by reaching into the internals
    const revoked = (set as unknown as { revoked: Map<string, number> }).revoked;
    revoked.set("old-jti", Date.now() - 11 * 60 * 1000); // 11 min ago
    revoked.set("recent-jti", Date.now() - 1000); // 1 second ago

    expect(set.size).toBe(2);
    const pruned = set.prune();
    expect(pruned).toBe(1);
    expect(set.size).toBe(1);
    expect(set.isRevoked("old-jti")).toBe(false);
    expect(set.isRevoked("recent-jti")).toBe(true);
  });

  test("prune with no expired entries returns 0", () => {
    const set = new JtiRevocationSet();
    set.add("fresh");
    expect(set.prune()).toBe(0);
    expect(set.size).toBe(1);
  });

  test("prune on empty set returns 0", () => {
    const set = new JtiRevocationSet();
    expect(set.prune()).toBe(0);
  });
});
