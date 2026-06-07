import { describe, test, expect } from "bun:test";
import {
  validateUsername,
  deriveUsernameFromEmail,
  RESERVED_USERNAMES,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
} from "./usernames";

describe("validateUsername", () => {
  test("accepts a valid lowercase username", () => {
    expect(validateUsername("justin")).toEqual({ ok: true, username: "justin" });
  });

  test("lowercases mixed-case input", () => {
    expect(validateUsername("Justin")).toEqual({ ok: true, username: "justin" });
    expect(validateUsername("JUSTIN_42")).toEqual({ ok: true, username: "justin_42" });
  });

  test("trims surrounding whitespace before validating", () => {
    expect(validateUsername("  justin  ")).toEqual({ ok: true, username: "justin" });
  });

  test("rejects non-string input", () => {
    expect(validateUsername(null)).toEqual({ ok: false, error: "username_required" });
    expect(validateUsername(undefined)).toEqual({ ok: false, error: "username_required" });
    expect(validateUsername(42)).toEqual({ ok: false, error: "username_required" });
  });

  test("rejects empty / whitespace-only input as username_required", () => {
    expect(validateUsername("")).toEqual({ ok: false, error: "username_required" });
    expect(validateUsername("   ")).toEqual({ ok: false, error: "username_required" });
  });

  test("rejects too-short input", () => {
    expect(validateUsername("ab")).toEqual({ ok: false, error: "username_too_short" });
  });

  test("rejects too-long input", () => {
    const long = "a".repeat(USERNAME_MAX_LENGTH + 1);
    expect(validateUsername(long)).toEqual({ ok: false, error: "username_too_long" });
  });

  test("accepts the boundary lengths", () => {
    const min = "a".repeat(USERNAME_MIN_LENGTH);
    const max = "a".repeat(USERNAME_MAX_LENGTH);
    expect(validateUsername(min)).toEqual({ ok: true, username: min });
    expect(validateUsername(max)).toEqual({ ok: true, username: max });
  });

  test("rejects non-allowed charset (hyphens, dots, spaces, unicode)", () => {
    expect(validateUsername("hello-world")).toEqual({ ok: false, error: "username_charset" });
    expect(validateUsername("hello.world")).toEqual({ ok: false, error: "username_charset" });
    expect(validateUsername("hello world")).toEqual({ ok: false, error: "username_charset" });
    // Cyrillic 'a' that visually mimics ASCII 'a' — homograph protection.
    expect(validateUsername("аdmin")).toEqual({ ok: false, error: "username_charset" });
  });

  test("rejects reserved system names", () => {
    expect(validateUsername("admin")).toEqual({ ok: false, error: "username_reserved" });
    expect(validateUsername("UnCorded")).toEqual({ ok: false, error: "username_reserved" });
    expect(validateUsername("Root")).toEqual({ ok: false, error: "username_reserved" });
  });

  test("rejects reserved routing names", () => {
    expect(validateUsername("api")).toEqual({ ok: false, error: "username_reserved" });
    expect(validateUsername("login")).toEqual({ ok: false, error: "username_reserved" });
    expect(validateUsername("settings")).toEqual({ ok: false, error: "username_reserved" });
  });

  test("reserved set entries are themselves all valid charset/length", () => {
    // Sanity check: every reserved name must itself pass the charset+length
    // gate, otherwise it would be unreachable as a reserved-name error
    // (charset would reject first). Catches typos in the reserved list.
    for (const name of RESERVED_USERNAMES) {
      expect(name).toMatch(/^[a-z0-9_]+$/);
      expect(name.length).toBeGreaterThanOrEqual(USERNAME_MIN_LENGTH);
      expect(name.length).toBeLessThanOrEqual(USERNAME_MAX_LENGTH);
    }
  });
});

describe("deriveUsernameFromEmail", () => {
  test("strips the local part and lowercases", () => {
    expect(deriveUsernameFromEmail("Justin@example.com")).toBe("justin");
  });

  test("replaces invalid charset with underscores", () => {
    expect(deriveUsernameFromEmail("first.last@example.com")).toBe("first_last");
    expect(deriveUsernameFromEmail("user+tag@example.com")).toBe("user_tag");
  });

  test("collapses runs of underscores and trims edges", () => {
    expect(deriveUsernameFromEmail("a..b@example.com")).toBe("a_b");
    expect(deriveUsernameFromEmail(".weird.@example.com")).toBe("weird");
  });

  test("clamps to USERNAME_MAX_LENGTH", () => {
    const long = "a".repeat(40) + "@example.com";
    const out = deriveUsernameFromEmail(long);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(USERNAME_MAX_LENGTH);
  });

  test("returns null when the result is too short", () => {
    expect(deriveUsernameFromEmail("a@example.com")).toBe(null);
    expect(deriveUsernameFromEmail("---@example.com")).toBe(null);
  });

  test("handles missing @ gracefully", () => {
    expect(deriveUsernameFromEmail("notanemail")).toBe("notanemail");
  });

  test("derived candidates always satisfy the username charset", () => {
    // The derived form is intentionally not run through the reserved-name
    // gate here (callers handle that — the caller may want to suffix-bump
    // a collision before treating the result as final). But the charset
    // and length constraints must always hold so the caller can pass the
    // result back through validateUsername without surprises.
    const samples = [
      "first.last+tag@example.com",
      "ALICE.SMITH@example.com",
      "weird....name@example.com",
    ];
    for (const email of samples) {
      const derived = deriveUsernameFromEmail(email);
      expect(derived).not.toBeNull();
      expect(derived!).toMatch(/^[a-z0-9_]+$/);
      expect(derived!.length).toBeGreaterThanOrEqual(USERNAME_MIN_LENGTH);
      expect(derived!.length).toBeLessThanOrEqual(USERNAME_MAX_LENGTH);
    }
  });
});
