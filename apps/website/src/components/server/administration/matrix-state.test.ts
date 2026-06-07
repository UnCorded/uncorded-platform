// Pure tri-state helpers (spec-22 Amendment B PR 4.3). These pin the
// wire-shape contract between the runtime's `role.overrides` array and
// the matrix UI's three-button segmented control.

import { describe, expect, it } from "bun:test";
import { pendingOpFor, triFromOverride } from "./matrix-state";

describe("triFromOverride", () => {
  it("returns 'inherit' when overrides is undefined", () => {
    expect(triFromOverride("plugin.foo", undefined)).toBe("inherit");
  });

  it("returns 'inherit' when overrides is empty", () => {
    expect(triFromOverride("plugin.foo", [])).toBe("inherit");
  });

  it("returns 'inherit' when the key is absent from overrides", () => {
    expect(
      triFromOverride("plugin.foo", [
        { permission: "plugin.bar", granted: true },
      ]),
    ).toBe("inherit");
  });

  it("returns 'grant' when the override has granted=true", () => {
    expect(
      triFromOverride("plugin.foo", [
        { permission: "plugin.foo", granted: true },
      ]),
    ).toBe("grant");
  });

  it("returns 'deny' when the override has granted=false", () => {
    expect(
      triFromOverride("plugin.foo", [
        { permission: "plugin.foo", granted: false },
      ]),
    ).toBe("deny");
  });

  it("matches the first occurrence of the key", () => {
    // Defensive: the runtime should never emit duplicates, but a test
    // pins the linear-scan behavior in case it does.
    expect(
      triFromOverride("plugin.foo", [
        { permission: "plugin.foo", granted: true },
        { permission: "plugin.foo", granted: false },
      ]),
    ).toBe("grant");
  });
});

describe("pendingOpFor", () => {
  it("maps 'grant' → 'grant'", () => {
    expect(pendingOpFor("grant")).toBe("grant");
  });

  it("maps 'deny' → 'deny'", () => {
    expect(pendingOpFor("deny")).toBe("deny");
  });

  it("maps 'inherit' → 'remove' (delete the override row)", () => {
    expect(pendingOpFor("inherit")).toBe("remove");
  });
});
