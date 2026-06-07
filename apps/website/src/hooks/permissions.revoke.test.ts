// Revoke scenario for `useHasPermission` (spec-22 Amendment B PR 5.1).
// Models the plan's revoke flow:
//
//   1. Actor A is admin (level 80) with `core.permissions.manage` granted
//      by an explicit role override. The hook says they can manage.
//   2. From another window, the owner removes the override.
//   3. The `core.permission.changed` listener (membership.ts:108) refetches
//      `core.member.me`, which carries `role_id`. The roles store also
//      refetches and the override row vanishes.
//   4. Next render: the hook re-evaluates. Default level is 100, member
//      level is 80, no override → returns false. Admin UI hides.
//
// This test drives the *pure* evaluator with the same before/after inputs
// the hook would see across that refetch, so the contract is guarded
// without a SolidJS renderer.

import { describe, expect, it } from "bun:test";
import {
  evaluateHasPermission,
  type MemberInput,
  type PermissionInput,
  type RoleInput,
} from "./has-permission-eval";

const MANAGE: PermissionInput = { key: "core.permissions.manage", defaultLevel: 100 };

describe("revoke scenario — admin loses core.permissions.manage via override removal", () => {
  it("hook returns true while the role override grants the permission", () => {
    const me: MemberInput = { is_owner: false, level: 80, role_id: 2 };
    const adminRole: RoleInput = {
      id: 2,
      overrides: [{ permission: MANAGE.key, granted: true }],
    };
    expect(evaluateHasPermission(me, adminRole, MANAGE)).toBe(true);
  });

  it("hook returns false on the next render after the override is removed", () => {
    // After the owner clicks "Inherit" on the matrix, role.overrides no longer
    // contains the manage row. Member level (80) is below default_level (100),
    // so the fall-through rule denies.
    const me: MemberInput = { is_owner: false, level: 80, role_id: 2 };
    const adminRoleAfter: RoleInput = { id: 2, overrides: [] };
    expect(evaluateHasPermission(me, adminRoleAfter, MANAGE)).toBe(false);
  });

  it("hook returns false even when overrides include unrelated permissions", () => {
    // A common case during the revoke transition: only the *manage* row is
    // removed; other overrides remain. The hook must not be fooled by the
    // sibling rows.
    const me: MemberInput = { is_owner: false, level: 80, role_id: 2 };
    const role: RoleInput = {
      id: 2,
      overrides: [
        { permission: "plugin.gallery.upload", granted: true },
        { permission: "plugin.gallery.delete", granted: false },
      ],
    };
    expect(evaluateHasPermission(me, role, MANAGE)).toBe(false);
  });

  it("the deny-override path also revokes (override granted=false)", () => {
    // An owner can also revoke by *denying* explicitly, which beats any
    // future level promotion. Useful for "naughty admin" scenarios.
    const me: MemberInput = { is_owner: false, level: 100, role_id: 2 };
    const role: RoleInput = {
      id: 2,
      overrides: [{ permission: MANAGE.key, granted: false }],
    };
    expect(evaluateHasPermission(me, role, MANAGE)).toBe(false);
  });

  it("revoke is no-op for owners — owner bypass beats all role state", () => {
    const me: MemberInput = { is_owner: true, level: 100, role_id: null };
    expect(evaluateHasPermission(me, null, MANAGE)).toBe(true);
  });
});
