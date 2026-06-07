import { describe, expect, test } from "bun:test";
import { parseSemver, satisfiesRange } from "./semver";

// ---------------------------------------------------------------------------
// parseSemver
// ---------------------------------------------------------------------------

describe("parseSemver", () => {
  test("parses valid semver", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  test("parses zero version", () => {
    expect(parseSemver("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 });
  });

  test("parses large numbers", () => {
    expect(parseSemver("100.200.300")).toEqual({ major: 100, minor: 200, patch: 300 });
  });

  test("rejects missing patch", () => {
    expect(parseSemver("1.2")).toBeNull();
  });

  test("rejects pre-release suffix", () => {
    expect(parseSemver("1.2.3-beta")).toBeNull();
  });

  test("rejects build metadata", () => {
    expect(parseSemver("1.2.3+build")).toBeNull();
  });

  test("rejects non-numeric", () => {
    expect(parseSemver("abc")).toBeNull();
  });

  test("rejects empty string", () => {
    expect(parseSemver("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// satisfiesRange — caret ranges
// ---------------------------------------------------------------------------

describe("satisfiesRange — caret ranges", () => {
  test("exact match satisfies", () => {
    expect(satisfiesRange("1.2.3", "^1.2.3")).toBe(true);
  });

  test("higher patch satisfies", () => {
    expect(satisfiesRange("1.2.5", "^1.2.3")).toBe(true);
  });

  test("higher minor satisfies", () => {
    expect(satisfiesRange("1.3.0", "^1.2.3")).toBe(true);
  });

  test("lower patch does not satisfy", () => {
    expect(satisfiesRange("1.2.2", "^1.2.3")).toBe(false);
  });

  test("lower minor does not satisfy", () => {
    expect(satisfiesRange("1.1.9", "^1.2.0")).toBe(false);
  });

  test("different major does not satisfy", () => {
    expect(satisfiesRange("2.0.0", "^1.2.3")).toBe(false);
  });

  test("major 0 does not satisfy higher major", () => {
    expect(satisfiesRange("1.0.0", "^0.5.0")).toBe(false);
  });

  // Caret range without patch: ^1.2 means ^1.2.0
  test("^X.Y (no patch) — exact minor match", () => {
    expect(satisfiesRange("1.2.0", "^1.2")).toBe(true);
  });

  test("^X.Y — higher minor satisfies", () => {
    expect(satisfiesRange("1.5.0", "^1.2")).toBe(true);
  });

  test("^X.Y — lower minor does not satisfy", () => {
    expect(satisfiesRange("1.1.0", "^1.2")).toBe(false);
  });

  test("^X.Y — different major does not satisfy", () => {
    expect(satisfiesRange("2.2.0", "^1.2")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// satisfiesRange — major 0 (caret pins to minor)
// ---------------------------------------------------------------------------

describe("satisfiesRange — major 0", () => {
  test("^0.1.0 allows 0.1.5", () => {
    expect(satisfiesRange("0.1.5", "^0.1.0")).toBe(true);
  });

  test("^0.1.0 rejects 0.2.0 (minor bump)", () => {
    expect(satisfiesRange("0.2.0", "^0.1.0")).toBe(false);
  });

  test("^0.1.0 rejects 0.0.9 (lower minor)", () => {
    expect(satisfiesRange("0.0.9", "^0.1.0")).toBe(false);
  });

  test("^0.0.5 allows 0.0.5 (exact)", () => {
    expect(satisfiesRange("0.0.5", "^0.0.5")).toBe(true);
  });

  test("^0.0.5 allows 0.0.9 (higher patch, same minor)", () => {
    expect(satisfiesRange("0.0.9", "^0.0.5")).toBe(true);
  });

  test("^0.0.5 rejects 0.0.4 (lower patch)", () => {
    expect(satisfiesRange("0.0.4", "^0.0.5")).toBe(false);
  });

  test("^0.0.5 rejects 0.1.0 (minor bump)", () => {
    expect(satisfiesRange("0.1.0", "^0.0.5")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// satisfiesRange — bare versions (no caret)
// ---------------------------------------------------------------------------

describe("satisfiesRange — bare versions", () => {
  test("bare X.Y.Z treated as caret", () => {
    expect(satisfiesRange("1.2.5", "1.2.3")).toBe(true);
  });

  test("bare X.Y treated as ^X.Y.0", () => {
    expect(satisfiesRange("1.3.0", "1.2")).toBe(true);
  });

  test("bare version rejects different major", () => {
    expect(satisfiesRange("2.0.0", "1.2.3")).toBe(false);
  });

  test("bare version rejects lower minor", () => {
    expect(satisfiesRange("1.1.0", "1.2")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// satisfiesRange — invalid inputs
// ---------------------------------------------------------------------------

describe("satisfiesRange — invalid inputs", () => {
  test("invalid version returns false", () => {
    expect(satisfiesRange("not-a-version", "^1.0")).toBe(false);
  });

  test("invalid range returns false", () => {
    expect(satisfiesRange("1.0.0", "latest")).toBe(false);
  });

  test("empty version returns false", () => {
    expect(satisfiesRange("", "^1.0")).toBe(false);
  });

  test("empty range returns false", () => {
    expect(satisfiesRange("1.0.0", "")).toBe(false);
  });

  test("wildcard range returns false", () => {
    expect(satisfiesRange("1.0.0", "*")).toBe(false);
  });

  test("tilde range returns false", () => {
    expect(satisfiesRange("1.0.0", "~1.0")).toBe(false);
  });
});
