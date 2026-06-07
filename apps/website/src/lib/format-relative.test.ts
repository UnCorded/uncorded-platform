import { describe, expect, it } from "bun:test";
import { formatRelative } from "./format-relative";

const NOW = 1_700_000_000_000;

describe("formatRelative", () => {
  it("'just now' under 30s", () => {
    expect(formatRelative(NOW - 5_000, NOW)).toBe("just now");
    expect(formatRelative(NOW + 5_000, NOW)).toBe("just now");
  });

  it("returns minutes when < 1 hour ago", () => {
    expect(formatRelative(NOW - 60_000, NOW)).toMatch(/minute/);
    expect(formatRelative(NOW - 30 * 60_000, NOW)).toMatch(/minute/);
  });

  it("returns hours when < 1 day ago", () => {
    expect(formatRelative(NOW - 60 * 60_000, NOW)).toMatch(/hour/);
  });

  it("returns days when < 14 days ago", () => {
    expect(formatRelative(NOW - 3 * 86_400_000, NOW)).toMatch(/day/);
  });

  it("returns ISO YYYY-MM-DD when >= 14 days ago", () => {
    const out = formatRelative(NOW - 30 * 86_400_000, NOW);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
