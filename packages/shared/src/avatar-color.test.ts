import { describe, expect, test } from "bun:test";
import { getClientColor, getClientColorString, getNameInitial } from "./avatar-color";

describe("getClientColor", () => {
  test("returns the same triplet across many calls (deterministic)", () => {
    const a = getClientColor("user-1");
    for (let i = 0; i < 50; i++) {
      const b = getClientColor("user-1");
      expect(b).toEqual(a);
    }
  });

  test("all three roles share the same hue family", () => {
    const c = getClientColor("user-x");
    const hueRe = /^hsl\((\d+(?:\.\d+)?), /;
    const bgHue = c.background.match(hueRe)?.[1];
    const fgHue = c.foreground.match(hueRe)?.[1];
    const acHue = c.accent.match(hueRe)?.[1];
    expect(bgHue).toBeDefined();
    expect(bgHue).toEqual(fgHue);
    expect(bgHue).toEqual(acHue);
  });

  test("background uses pastel lightness, accent uses vivid lightness", () => {
    const c = getClientColor("user-1");
    expect(c.background).toContain("100%, 83%");
    expect(c.foreground).toContain("60%, 18%");
    expect(c.accent).toContain("75%, 45%");
  });

  test("distribution: 1000 random ids hit a wide spread of hue buckets", () => {
    const buckets = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = `${Math.random()}-${i}`;
      const hue = getClientColor(id).accent.match(/^hsl\((\d+(?:\.\d+)?), /)?.[1];
      if (hue) buckets.add(hue);
    }
    // 37 possible buckets; allow some statistical slack but expect >=30 hit.
    expect(buckets.size).toBeGreaterThanOrEqual(30);
  });

  test("getClientColorString returns the accent variant", () => {
    const c = getClientColor("user-z");
    expect(getClientColorString("user-z")).toEqual(c.accent);
  });

  test("hue is always in [0, 360)", () => {
    for (let i = 0; i < 200; i++) {
      const hue = Number(
        getClientColor(`id-${i}`).accent.match(/^hsl\((\d+(?:\.\d+)?), /)![1],
      );
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});

describe("getNameInitial", () => {
  test("returns ? for null/undefined/empty/whitespace", () => {
    expect(getNameInitial(undefined)).toBe("?");
    expect(getNameInitial(null)).toBe("?");
    expect(getNameInitial("")).toBe("?");
    expect(getNameInitial("   ")).toBe("?");
    expect(getNameInitial("\t\n")).toBe("?");
  });

  test("ASCII names → first letter uppercased", () => {
    expect(getNameInitial("alice")).toBe("A");
    expect(getNameInitial("Bob")).toBe("B");
    expect(getNameInitial("zelda hyrule")).toBe("Z");
  });

  test("single character", () => {
    expect(getNameInitial("x")).toBe("X");
    expect(getNameInitial("Q")).toBe("Q");
  });

  test("RTL names take the first character", () => {
    // First Hebrew letter (Aleph). Uppercase is identity for these.
    expect(getNameInitial("אבג")).toBe("א");
  });

  test("emoji-prefixed names return the emoji glyph", () => {
    // Single-codepoint emoji — both segmenter and fallback agree.
    expect(getNameInitial("🚀 Launcher")).toBe("🚀");
  });

  test("multi-codepoint emoji (skin tone modifier) stays intact under segmenter", () => {
    // 👋 + 🏽 = single grapheme. With Intl.Segmenter we expect the full cluster;
    // without it, only the base codepoint. Accept either since both are valid
    // first-visible-char interpretations.
    const result = getNameInitial("👋🏽 hi");
    expect(["👋🏽", "👋"]).toContain(result);
  });

  test("ZWJ sequence (family) — segmenter returns full cluster, fallback returns base", () => {
    // 👨‍👩‍👧 = man + ZWJ + woman + ZWJ + girl. Single grapheme cluster.
    const result = getNameInitial("👨‍👩‍👧 family");
    expect(["👨‍👩‍👧", "👨"]).toContain(result);
  });
});
