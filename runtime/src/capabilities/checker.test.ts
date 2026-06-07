import { describe, expect, test } from "bun:test";
import {
  parseCapability,
  scopeMatches,
  CapabilityChecker,
} from "./checker";

// ---------------------------------------------------------------------------
// parseCapability
// ---------------------------------------------------------------------------

describe("parseCapability", () => {
  test("parses resource.action without scope", () => {
    expect(parseCapability("auth.currentUser")).toEqual({
      resourceAction: "auth.currentUser",
      scope: null,
    });
  });

  test("parses resource.action with scope", () => {
    expect(parseCapability("data.sql:self")).toEqual({
      resourceAction: "data.sql",
      scope: "self",
    });
  });

  test("parses wildcard scope", () => {
    expect(parseCapability("events.publish:text-channels.*")).toEqual({
      resourceAction: "events.publish",
      scope: "text-channels.*",
    });
  });

  test("scope may contain additional colons", () => {
    expect(parseCapability("http.fetch:api.example.com:8080")).toEqual({
      resourceAction: "http.fetch",
      scope: "api.example.com:8080",
    });
  });

  test("global wildcard scope", () => {
    expect(parseCapability("events.publish:*")).toEqual({
      resourceAction: "events.publish",
      scope: "*",
    });
  });
});

// ---------------------------------------------------------------------------
// scopeMatches
// ---------------------------------------------------------------------------

describe("scopeMatches", () => {
  test("both null → match", () => {
    expect(scopeMatches(null, null)).toBe(true);
  });

  test("declared null, requested has scope → no match", () => {
    expect(scopeMatches(null, "self")).toBe(false);
  });

  test("declared has scope, requested null → no match", () => {
    expect(scopeMatches("self", null)).toBe(false);
  });

  test("exact match", () => {
    expect(scopeMatches("self", "self")).toBe(true);
  });

  test("exact mismatch", () => {
    expect(scopeMatches("self", "other")).toBe(false);
  });

  test("global wildcard matches anything", () => {
    expect(scopeMatches("*", "anything.here")).toBe(true);
    expect(scopeMatches("*", "self")).toBe(true);
    expect(scopeMatches("*", "x")).toBe(true);
  });

  test("trailing wildcard matches dotted suffix", () => {
    expect(scopeMatches("text-channels.*", "text-channels.message.created")).toBe(true);
    expect(scopeMatches("text-channels.*", "text-channels.x")).toBe(true);
  });

  test("trailing wildcard requires at least one segment after dot", () => {
    expect(scopeMatches("text-channels.*", "text-channels")).toBe(false);
    expect(scopeMatches("text-channels.*", "text-channels.")).toBe(false);
  });

  test("trailing wildcard does not match different prefix", () => {
    expect(scopeMatches("text-channels.*", "other-plugin.message.created")).toBe(false);
  });

  test("nested wildcard", () => {
    expect(scopeMatches("runtime.cascade.*", "runtime.cascade.user.deleted")).toBe(true);
  });

  test("scope with colons matches exactly", () => {
    expect(scopeMatches("api.example.com:8080", "api.example.com:8080")).toBe(true);
    expect(scopeMatches("api.example.com:8080", "api.example.com:9090")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CapabilityChecker — exact matches
// ---------------------------------------------------------------------------

describe("CapabilityChecker exact matches", () => {
  test("data.sql:self allows data.sql:self", () => {
    const checker = new CapabilityChecker("test-plugin", ["data.sql:self"]);
    expect(checker.isAllowed("data.sql:self")).toBe(true);
  });

  test("data.sql:self denies data.sql:other", () => {
    const checker = new CapabilityChecker("test-plugin", ["data.sql:self"]);
    expect(checker.isAllowed("data.sql:other")).toBe(false);
  });

  test("auth.currentUser allows auth.currentUser", () => {
    const checker = new CapabilityChecker("test-plugin", ["auth.currentUser"]);
    expect(checker.isAllowed("auth.currentUser")).toBe(true);
  });

  test("auth.currentUser denies auth.currentUser:extra", () => {
    const checker = new CapabilityChecker("test-plugin", ["auth.currentUser"]);
    expect(checker.isAllowed("auth.currentUser:extra")).toBe(false);
  });

  test("runtime.log allows runtime.log", () => {
    const checker = new CapabilityChecker("test-plugin", ["runtime.log"]);
    expect(checker.isAllowed("runtime.log")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CapabilityChecker — wildcard scope
// ---------------------------------------------------------------------------

describe("CapabilityChecker wildcard scope", () => {
  test("events.publish:text-channels.* allows text-channels.message.created", () => {
    const checker = new CapabilityChecker("test-plugin", [
      "events.publish:text-channels.*",
    ]);
    expect(checker.isAllowed("events.publish:text-channels.message.created")).toBe(true);
  });

  test("events.publish:text-channels.* allows text-channels.x", () => {
    const checker = new CapabilityChecker("test-plugin", [
      "events.publish:text-channels.*",
    ]);
    expect(checker.isAllowed("events.publish:text-channels.x")).toBe(true);
  });

  test("events.publish:text-channels.* denies text-channels (no segment after)", () => {
    const checker = new CapabilityChecker("test-plugin", [
      "events.publish:text-channels.*",
    ]);
    expect(checker.isAllowed("events.publish:text-channels")).toBe(false);
  });

  test("events.publish:text-channels.* denies other-plugin.message.created", () => {
    const checker = new CapabilityChecker("test-plugin", [
      "events.publish:text-channels.*",
    ]);
    expect(checker.isAllowed("events.publish:other-plugin.message.created")).toBe(false);
  });

  test("events.subscribe:runtime.cascade.* allows runtime.cascade.user.deleted", () => {
    const checker = new CapabilityChecker("test-plugin", [
      "events.subscribe:runtime.cascade.*",
    ]);
    expect(checker.isAllowed("events.subscribe:runtime.cascade.user.deleted")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CapabilityChecker — global wildcard
// ---------------------------------------------------------------------------

describe("CapabilityChecker global wildcard", () => {
  test("events.publish:* allows events.publish:anything.here", () => {
    const checker = new CapabilityChecker("test-plugin", ["events.publish:*"]);
    expect(checker.isAllowed("events.publish:anything.here")).toBe(true);
  });

  test("events.publish:* allows events.publish:single", () => {
    const checker = new CapabilityChecker("test-plugin", ["events.publish:*"]);
    expect(checker.isAllowed("events.publish:single")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CapabilityChecker — cross-resource denial
// ---------------------------------------------------------------------------

describe("CapabilityChecker cross-resource denial", () => {
  test("data.sql:self denies data.kv:self", () => {
    const checker = new CapabilityChecker("test-plugin", ["data.sql:self"]);
    expect(checker.isAllowed("data.kv:self")).toBe(false);
  });

  test("events.publish:text-channels.* denies events.subscribe:text-channels.foo", () => {
    const checker = new CapabilityChecker("test-plugin", [
      "events.publish:text-channels.*",
    ]);
    expect(checker.isAllowed("events.subscribe:text-channels.foo")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CapabilityChecker — multiple permissions
// ---------------------------------------------------------------------------

describe("CapabilityChecker multiple permissions", () => {
  const checker = new CapabilityChecker("text-channels", [
    "data.sql:self",
    "data.kv:self",
    "events.publish:text-channels.*",
    "events.subscribe:runtime.cascade.*",
    "storage.file:self",
    "auth.currentUser",
  ]);

  test("allows data.sql:self", () => {
    expect(checker.isAllowed("data.sql:self")).toBe(true);
  });

  test("allows events.publish:text-channels.message.created", () => {
    expect(checker.isAllowed("events.publish:text-channels.message.created")).toBe(true);
  });

  test("allows events.subscribe:runtime.cascade.user.deleted", () => {
    expect(checker.isAllowed("events.subscribe:runtime.cascade.user.deleted")).toBe(true);
  });

  test("allows auth.currentUser", () => {
    expect(checker.isAllowed("auth.currentUser")).toBe(true);
  });

  test("denies http.fetch:example.com (not in list)", () => {
    expect(checker.isAllowed("http.fetch:example.com")).toBe(false);
  });

  test("denies events.publish:other-plugin.foo (wrong scope)", () => {
    expect(checker.isAllowed("events.publish:other-plugin.foo")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CapabilityChecker — edge cases
// ---------------------------------------------------------------------------

describe("CapabilityChecker edge cases", () => {
  test("empty permissions array denies everything", () => {
    const checker = new CapabilityChecker("empty-plugin", []);
    expect(checker.isAllowed("data.sql:self")).toBe(false);
    expect(checker.isAllowed("auth.currentUser")).toBe(false);
  });

  test("scope with extra colons (http.fetch:host:port)", () => {
    const checker = new CapabilityChecker("api-plugin", [
      "http.fetch:api.example.com:8080",
    ]);
    expect(checker.isAllowed("http.fetch:api.example.com:8080")).toBe(true);
    expect(checker.isAllowed("http.fetch:api.example.com:9090")).toBe(false);
    expect(checker.isAllowed("http.fetch:api.example.com")).toBe(false);
  });

  test("data.read with plugin.table scope", () => {
    const checker = new CapabilityChecker("reactions", [
      "data.read:text-channels.messages",
    ]);
    expect(checker.isAllowed("data.read:text-channels.messages")).toBe(true);
    expect(checker.isAllowed("data.read:text-channels.drafts")).toBe(false);
    expect(checker.isAllowed("data.read:text-channels.messages.extra")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CapabilityChecker.check() — structured result
// ---------------------------------------------------------------------------

describe("CapabilityChecker.check()", () => {
  test("returns ok: true for allowed capability", () => {
    const checker = new CapabilityChecker("test-plugin", ["data.sql:self"]);
    const result = checker.check("data.sql:self");
    expect(result.ok).toBe(true);
  });

  test("returns denial with details for rejected capability", () => {
    const checker = new CapabilityChecker("test-plugin", ["data.sql:self"]);
    const result = checker.check("data.kv:self");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CAPABILITY_DENIED");
      expect(result.permission).toBe("data.kv:self");
      expect(result.plugin).toBe("test-plugin");
      expect(result.message).toContain("test-plugin");
      expect(result.message).toContain("data.kv:self");
    }
  });
});
