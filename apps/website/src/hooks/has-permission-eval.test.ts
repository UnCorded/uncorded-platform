// Pure-evaluator coverage for `useHasPermission` (spec-22 Amendment B
// PR 5.1). Every case mirrors RolesEngine.check() — UI gates that return
// `true` here while the runtime returns `false` (or vice-versa) are bugs.

import { describe, expect, it } from "bun:test";
import {
  evaluateHasPermission,
  type MemberInput,
  type PermissionInput,
  type RoleInput,
} from "./has-permission-eval";

const PERM: PermissionInput = { key: "core.permissions.manage", defaultLevel: 100 };

const member = (
  partial: Partial<MemberInput> = {},
): MemberInput => ({
  is_owner: false,
  level: 80,
  role_id: 2,
  ...partial,
});

const role = (
  overrides: Array<{ permission: string; granted: boolean }> = [],
  id = 2,
): RoleInput => ({ id, overrides });

describe("evaluateHasPermission — owner bypass", () => {
  it("returns true even with no permission row", () => {
    expect(evaluateHasPermission(member({ is_owner: true }), null, null)).toBe(true);
  });

  it("returns true even when the role is missing", () => {
    expect(evaluateHasPermission(member({ is_owner: true }), null, PERM)).toBe(true);
  });
});

describe("evaluateHasPermission — null guards", () => {
  it("null member → false", () => {
    expect(evaluateHasPermission(null, null, PERM)).toBe(false);
  });

  it("non-owner with null permission → false (unknown key)", () => {
    expect(evaluateHasPermission(member(), null, null)).toBe(false);
  });
});

describe("evaluateHasPermission — explicit role override wins", () => {
  it("granted=true override beats sub-default-level (rule 3)", () => {
    // Member level 30, default_level 100, but role overrides grant=true.
    const out = evaluateHasPermission(
      member({ level: 30 }),
      role([{ permission: PERM.key, granted: true }]),
      PERM,
    );
    expect(out).toBe(true);
  });

  it("granted=false override beats above-default-level (rule 3)", () => {
    // Member level 100, default_level 50, but role overrides grant=false.
    const out = evaluateHasPermission(
      member({ level: 100 }),
      role([{ permission: PERM.key, granted: false }]),
      { key: PERM.key, defaultLevel: 50 },
    );
    expect(out).toBe(false);
  });

  it("override on a different role is ignored when role.id !== member.role_id", () => {
    // The role passed in is a SIBLING role, not the member's own role.
    // A grant override on someone else's role must not leak through.
    const out = evaluateHasPermission(
      member({ level: 30, role_id: 2 }),
      role([{ permission: PERM.key, granted: true }], 99),
      PERM,
    );
    expect(out).toBe(false);
  });
});

describe("evaluateHasPermission — fall-through to default level", () => {
  it("level >= default_level → true (no override)", () => {
    expect(evaluateHasPermission(member({ level: 80 }), role(), { key: "x", defaultLevel: 60 })).toBe(true);
  });

  it("level < default_level → false (no override)", () => {
    expect(evaluateHasPermission(member({ level: 30 }), role(), { key: "x", defaultLevel: 60 })).toBe(false);
  });

  it("missing role still falls through to default_level (defensive)", () => {
    // The roles store may be cold; rather than failing closed in the UI we
    // honour level. The runtime is still authoritative.
    expect(evaluateHasPermission(member({ level: 80 }), null, { key: "x", defaultLevel: 60 })).toBe(true);
  });
});
