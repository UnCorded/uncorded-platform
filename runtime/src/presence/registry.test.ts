import { describe, expect, test } from "bun:test";
import { ScopeRegistry } from "./registry";
import type { PresenceEntryInternal } from "./types";

function entry(over: Partial<PresenceEntryInternal>): PresenceEntryInternal {
  return {
    scope: "text-channels.thread.t1",
    user_id: "u-1",
    session_id: "c-1",
    meta: {},
    joined_at: 1000,
    updated_at: 1000,
    plugin_slug: "text-channels",
    ...over,
  };
}

describe("ScopeRegistry — basic insert/get/list", () => {
  test("insert + get + list a single entry", () => {
    const r = new ScopeRegistry();
    r.insert(entry({}));
    expect(r.size()).toBe(1);
    expect(r.get("text-channels.thread.t1", "c-1")?.user_id).toBe("u-1");
    const list = r.list("text-channels.thread.t1");
    expect(list).toHaveLength(1);
    expect(list[0]!.scope).toBe("text-channels.thread.t1");
  });

  test("insert with same (scope, session) replaces and does not bump count", () => {
    const r = new ScopeRegistry();
    r.insert(entry({ meta: { typing: true } }));
    r.insert(entry({ meta: { typing: false }, updated_at: 2000 }));
    expect(r.size()).toBe(1);
    const got = r.get("text-channels.thread.t1", "c-1");
    expect(got?.meta).toEqual({ typing: false });
    expect(got?.updated_at).toBe(2000);
  });

  test("multi-session same user produces two entries in same scope", () => {
    const r = new ScopeRegistry();
    r.insert(entry({ session_id: "c-1", meta: { focused: true } }));
    r.insert(entry({ session_id: "c-2", meta: { focused: false } }));
    expect(r.size()).toBe(2);
    expect(r.scopeSize("text-channels.thread.t1")).toBe(2);
    expect(r.list("text-channels.thread.t1")).toHaveLength(2);
  });
});

describe("ScopeRegistry — secondary indexes", () => {
  test("scopesForSession returns the session's scopes", () => {
    const r = new ScopeRegistry();
    r.insert(entry({ scope: "text-channels.thread.a" }));
    r.insert(entry({ scope: "text-channels.thread.b" }));
    expect([...r.scopesForSession("c-1")].sort()).toEqual([
      "text-channels.thread.a",
      "text-channels.thread.b",
    ]);
  });

  test("scopesForPlugin returns the plugin's scopes", () => {
    const r = new ScopeRegistry();
    r.insert(entry({ scope: "text-channels.thread.a" }));
    r.insert(entry({ scope: "text-channels.thread.b", session_id: "c-2" }));
    r.insert(entry({
      scope: "voice.room.x",
      plugin_slug: "voice",
      session_id: "c-3",
    }));
    expect([...r.scopesForPlugin("text-channels")].sort()).toEqual([
      "text-channels.thread.a",
      "text-channels.thread.b",
    ]);
    expect(r.scopesForPlugin("voice")).toEqual(["voice.room.x"]);
  });
});

describe("ScopeRegistry — remove keeps indexes consistent", () => {
  test("remove drops session entry from secondary indexes", () => {
    const r = new ScopeRegistry();
    r.insert(entry({ scope: "text-channels.thread.a" }));
    r.insert(entry({ scope: "text-channels.thread.b" }));
    r.remove("text-channels.thread.a", "c-1");
    expect(r.size()).toBe(1);
    expect(r.scopesForSession("c-1")).toEqual(["text-channels.thread.b"]);
    expect(r.scopesForPlugin("text-channels")).toEqual(["text-channels.thread.b"]);
    expect(r.list("text-channels.thread.a")).toEqual([]);
  });

  test("remove last session in scope drops scope from byPlugin", () => {
    const r = new ScopeRegistry();
    r.insert(entry({ scope: "text-channels.thread.a" }));
    r.remove("text-channels.thread.a", "c-1");
    expect(r.scopesForPlugin("text-channels")).toEqual([]);
  });

  test("remove a session that still has another scope keeps session in byScope_session", () => {
    const r = new ScopeRegistry();
    r.insert(entry({ scope: "text-channels.thread.a" }));
    r.insert(entry({ scope: "text-channels.thread.b" }));
    r.remove("text-channels.thread.a", "c-1");
    expect(r.scopesForSession("c-1")).toEqual(["text-channels.thread.b"]);
  });

  test("remove on missing entry is a no-op", () => {
    const r = new ScopeRegistry();
    expect(r.remove("nope", "nope")).toBeUndefined();
    expect(r.size()).toBe(0);
  });
});
