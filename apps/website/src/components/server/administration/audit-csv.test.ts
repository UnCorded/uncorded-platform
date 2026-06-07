// CSV serialization for the Audit tab's "Export CSV" button (PR 5.3).
// The export pulls from the in-memory mergedRows() so the test only needs
// to feed MergedRow shapes — no SolidJS, no fetch.

import { describe, expect, it } from "bun:test";
import { rowsToCsv, type MergedRow } from "./audit-tab";

const FIXED_TS = Date.UTC(2026, 4, 6, 12, 0, 0); // 2026-05-06T12:00:00.000Z

const banRow: MergedRow = {
  ts: FIXED_TS,
  kind: "ban",
  banAction: "user.banned",
  banActorId: "u_actor",
  banTargetId: "u_target",
  banReason: "spam",
  uid: "b:1",
};

const permRow: MergedRow = {
  ts: FIXED_TS + 1000,
  kind: "permission",
  permAction: "grant",
  permActorId: "u_admin",
  permTargetRoleId: 7,
  permPermission: "plugin.text-channels.manage",
  permReason: "promoted to mod",
  uid: "p:1",
};

describe("rowsToCsv", () => {
  it("emits a header row even with no data", () => {
    const out = rowsToCsv([]);
    expect(out).toBe(
      "timestamp,kind,action,actor,target,permission,reason\n",
    );
  });

  it("serializes a ban row with ISO timestamp and empty permission column", () => {
    const out = rowsToCsv([banRow]);
    const lines = out.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[1]).toBe(
      "2026-05-06T12:00:00.000Z,ban,user.banned,u_actor,u_target,,spam",
    );
  });

  it("serializes a permission row with role:N target and perm.<action>", () => {
    const out = rowsToCsv([permRow]);
    const lines = out.trim().split("\n");
    expect(lines[1]).toBe(
      "2026-05-06T12:00:01.000Z,permission,perm.grant,u_admin,role:7,plugin.text-channels.manage,promoted to mod",
    );
  });

  it("preserves input order (caller already sorted by ts DESC)", () => {
    const out = rowsToCsv([permRow, banRow]);
    const lines = out.trim().split("\n");
    expect(lines[1]!.startsWith("2026-05-06T12:00:01.000Z")).toBe(true);
    expect(lines[2]!.startsWith("2026-05-06T12:00:00.000Z")).toBe(true);
  });

  it("RFC 4180 escapes commas, quotes, and newlines in reasons", () => {
    const trickyBan: MergedRow = {
      ...banRow,
      banReason: 'Said "hi", then left\nafter a fight',
    };
    const out = rowsToCsv([trickyBan]);
    // The reason cell must be wrapped in quotes; embedded quotes doubled.
    expect(out).toContain(
      '"Said ""hi"", then left\nafter a fight"',
    );
    // The pre-quote columns should still parse: no stray escaping leaks
    // into adjacent unproblematic fields.
    expect(out.split("\n")[1]!.startsWith(
      "2026-05-06T12:00:00.000Z,ban,user.banned,u_actor,u_target,,",
    )).toBe(true);
  });

  it("renders an empty target column when permTargetRoleId is null", () => {
    const noTarget: MergedRow = { ...permRow, permTargetRoleId: null };
    const out = rowsToCsv([noTarget]);
    // Two consecutive commas after the actor: actor,,permission
    expect(out).toContain(",u_admin,,plugin.text-channels.manage,");
  });

  it("renders an empty target column when banTargetId is null", () => {
    const noTarget: MergedRow = { ...banRow, banTargetId: null };
    const out = rowsToCsv([noTarget]);
    expect(out).toContain(",u_actor,,,spam");
  });

  it("ends with a trailing newline so all rows survive Excel import", () => {
    const out = rowsToCsv([banRow]);
    expect(out.endsWith("\n")).toBe(true);
  });
});
