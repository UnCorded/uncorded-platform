// CoView entitlement-class serializer (CV-FOUND-2 skeleton) tests.
//
// The serializer is the cache's correctness primitive: two viewers may share a
// projection ONLY when their serialized entitlement classes are byte-identical.
// These tests pin the canonical form from foundation-plan §4.7 — fixed field
// order, sorted sets, 0/1 booleans, empty-set-as-empty-value, and the one
// conditional field (render_mode).

import { describe, expect, test } from "bun:test";
import {
  serializeEntitlementClass,
  type CoViewEntitlementClass,
} from "./entitlement-class";

function base(over: Partial<CoViewEntitlementClass> = {}): CoViewEntitlementClass {
  return {
    roleSet: [],
    sessionVisibilityMode: "private",
    whitelistMembership: false,
    blacklistMembership: false,
    owner: false,
    banned: false,
    moderator: false,
    featureFlags: [],
    ...over,
  };
}

describe("serializeEntitlementClass — canonical form (§4.7)", () => {
  test("emits fields in the fixed order with 0/1 flags and empty sets as empty values", () => {
    const s = serializeEntitlementClass(base(), "as-host");
    expect(s).toBe(
      [
        "role_set=",
        "session_visibility_mode=private",
        "whitelist_membership_flag=0",
        "blacklist_membership_flag=0",
        "owner_flag=0",
        "banned_flag=0",
        "moderator_flag=0",
        "feature_flags=",
      ].join("\n"),
    );
  });

  test("is deterministic and order-insensitive for role/flag sets (sorted bytewise)", () => {
    const a = serializeEntitlementClass(
      base({ roleSet: ["mod", "admin", "member"], featureFlags: ["z-flag", "a-flag"] }),
      "as-host",
    );
    const b = serializeEntitlementClass(
      base({ roleSet: ["member", "mod", "admin"], featureFlags: ["a-flag", "z-flag"] }),
      "as-host",
    );
    expect(a).toBe(b);
    expect(a).toContain("role_set=admin,member,mod");
    expect(a).toContain("feature_flags=a-flag,z-flag");
  });

  test("does not mutate the caller's arrays", () => {
    const roleSet = ["b", "a"];
    serializeEntitlementClass(base({ roleSet }), "as-host");
    expect(roleSet).toEqual(["b", "a"]);
  });

  test("render_mode is OMITTED when it matches the session top-level mode", () => {
    const s = serializeEntitlementClass(base({ renderMode: "as-host" }), "as-host");
    expect(s).not.toContain("render_mode=");
  });

  test("render_mode is OMITTED when undefined", () => {
    const s = serializeEntitlementClass(base(), "as-host");
    expect(s).not.toContain("render_mode=");
  });

  test("render_mode is PRESENT (before feature_flags) when distinct from top-level", () => {
    const s = serializeEntitlementClass(base({ renderMode: "as-viewer" }), "as-host");
    expect(s).toContain("\nrender_mode=as-viewer\nfeature_flags=");
  });
});

describe("serializeEntitlementClass — no over-broad cache sharing (§4.7)", () => {
  // Each entitlement-affecting field must change the key, so viewers differing on
  // any of them never share a projection.
  const variants: Array<[string, Partial<CoViewEntitlementClass>]> = [
    ["baseline", {}],
    ["owner", { owner: true }],
    ["banned", { banned: true }],
    ["moderator", { moderator: true }],
    ["whitelist", { whitelistMembership: true }],
    ["blacklist", { blacklistMembership: true }],
    ["visibility", { sessionVisibilityMode: "public" }],
    ["roles", { roleSet: ["admin"] }],
    ["render-mode", { renderMode: "as-viewer" }],
    ["feature-flags", { featureFlags: ["beta"] }],
  ];

  test("every distinct entitlement-affecting field yields a distinct key", () => {
    const keys = variants.map(([, over]) => serializeEntitlementClass(base(over), "as-host"));
    expect(new Set(keys).size).toBe(variants.length);
  });
});
