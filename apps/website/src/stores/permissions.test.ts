// Unit tests for `assignableRoles` — the dropdown filter helper used by
// member-manage-sheet (spec-22 Amendment B PR 3).

import { describe, expect, it } from "bun:test";
import { assignableRoles } from "./permissions";

interface FakeRole {
  id: number;
  name: string;
  level: number;
}

const ALL_ROLES: FakeRole[] = [
  { id: 1, name: "owner", level: 100 },
  { id: 2, name: "admin", level: 80 },
  { id: 3, name: "moderator", level: 60 },
  { id: 4, name: "member", level: 10 },
  { id: 5, name: "trusted", level: 30 },
];

describe("assignableRoles", () => {
  it("hides the owner role (level 100) for owners", () => {
    const out = assignableRoles(Number.POSITIVE_INFINITY, true, ALL_ROLES);
    expect(out.find((r) => r.level === 100)).toBeUndefined();
  });

  it("shows every non-owner role to an owner", () => {
    const out = assignableRoles(Number.POSITIVE_INFINITY, true, ALL_ROLES);
    expect(out.map((r) => r.name).sort()).toEqual(
      ["admin", "member", "moderator", "trusted"].sort(),
    );
  });

  it("hides roles >= actor level for non-owners (strict-less-than)", () => {
    // Admin (level 80) can assign moderator (60), trusted (30), member (10),
    // but NOT another admin (80).
    const out = assignableRoles(80, false, ALL_ROLES);
    expect(out.map((r) => r.name).sort()).toEqual(
      ["member", "moderator", "trusted"].sort(),
    );
  });

  it("returns an empty list for a member-level actor", () => {
    // A member (level 10) has nothing strictly below them.
    const out = assignableRoles(10, false, ALL_ROLES);
    expect(out).toEqual([]);
  });

  it("hides the owner role even for an actor at level >= 100", () => {
    // Defensive: a misconfigured actor at level 100 (non-owner flag) still
    // does not get to dish out owner.
    const out = assignableRoles(100, false, ALL_ROLES);
    expect(out.find((r) => r.level === 100)).toBeUndefined();
  });
});
