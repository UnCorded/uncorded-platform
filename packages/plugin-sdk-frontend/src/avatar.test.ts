import { describe, expect, test } from "bun:test";
import {
  avatarColor,
  avatarHtml,
  avatarInitial,
  avatarTextColor,
  isSafeAvatarUrl,
} from "./avatar";

// Color logic now lives in @uncorded/shared (37-hue HSL hash). avatarColor
// returns the pastel `background` variant; avatarTextColor returns the dark
// `foreground`. Tests assert the wire format rather than specific hues so
// shared-util tweaks (palette growth, etc.) don't cascade here.

const HSL_TRIPLE = /^hsl\((\d+(?:\.\d+)?), (\d+)%, (\d+)%\)$/;

describe("avatarColor", () => {
  test("returns the pastel background HSL triple", () => {
    const m = HSL_TRIPLE.exec(avatarColor("alice"));
    expect(m).not.toBeNull();
    expect(m![2]).toBe("100");
    expect(m![3]).toBe("83");
  });

  test("is deterministic — same userId yields same color", () => {
    expect(avatarColor("user-42")).toBe(avatarColor("user-42"));
  });

  test("hue is always in [0, 360)", () => {
    for (const id of ["a", "b", "c", "d-e-f", "1234567890", "Z"]) {
      const m = HSL_TRIPLE.exec(avatarColor(id));
      expect(m).not.toBeNull();
      const hue = Number(m![1]);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});

describe("avatarTextColor", () => {
  test("returns the dark foreground HSL triple in the same hue family as avatarColor", () => {
    const bg = avatarColor("alice");
    const fg = avatarTextColor("alice");
    const fgMatch = HSL_TRIPLE.exec(fg);
    expect(fgMatch).not.toBeNull();
    expect(fgMatch![2]).toBe("60");
    expect(fgMatch![3]).toBe("18");
    // Same hue between fg and bg.
    expect(HSL_TRIPLE.exec(bg)![1]).toBe(fgMatch![1]);
  });
});

describe("avatarInitial", () => {
  test("returns first grapheme uppercased", () => {
    expect(avatarInitial("alice")).toBe("A");
    expect(avatarInitial("Zoë")).toBe("Z");
  });

  test("trims leading whitespace before extracting", () => {
    expect(avatarInitial("   bob")).toBe("B");
  });

  test("returns ? for null/undefined/empty/whitespace-only", () => {
    expect(avatarInitial(null)).toBe("?");
    expect(avatarInitial(undefined)).toBe("?");
    expect(avatarInitial("")).toBe("?");
    expect(avatarInitial("   ")).toBe("?");
  });

  test("handles surrogate pairs without slicing", () => {
    expect(avatarInitial("👋 hi")).toBe("👋");
  });
});

describe("isSafeAvatarUrl", () => {
  test("accepts http and https", () => {
    expect(isSafeAvatarUrl("http://example.com/a.png")).toBe(true);
    expect(isSafeAvatarUrl("https://example.com/a.png")).toBe(true);
    expect(isSafeAvatarUrl("HTTPS://EXAMPLE.COM/A.PNG")).toBe(true);
  });

  test("rejects javascript:, data:, relative paths, and non-strings", () => {
    expect(isSafeAvatarUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeAvatarUrl("data:image/png;base64,iVBOR=")).toBe(false);
    expect(isSafeAvatarUrl("/avatars/me.png")).toBe(false);
    expect(isSafeAvatarUrl("avatars/me.png")).toBe(false);
    expect(isSafeAvatarUrl(null)).toBe(false);
    expect(isSafeAvatarUrl(undefined)).toBe(false);
  });
});

describe("avatarHtml", () => {
  test("renders fallback markup when no avatarUrl is supplied", () => {
    const html = avatarHtml({ userId: "u1", displayName: "Alice" });
    expect(html).toContain("<div");
    expect(html).toContain("<span>A</span>");
    expect(html).not.toContain("<img");
  });

  test("renders an img tag when avatarUrl is a safe https URL", () => {
    const html = avatarHtml({
      userId: "u1",
      displayName: "Alice",
      avatarUrl: "https://cdn.example.com/a.png",
    });
    expect(html).toContain("<img src=\"https://cdn.example.com/a.png\"");
    expect(html).toContain("alt=\"Alice\"");
    expect(html).toContain("loading=\"lazy\"");
  });

  test("ignores unsafe avatarUrls and falls back to initial", () => {
    const html = avatarHtml({
      userId: "u1",
      displayName: "Alice",
      avatarUrl: "javascript:alert(1)",
    });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).toContain("<span>A</span>");
  });

  test("HTML-escapes hostile displayName", () => {
    const html = avatarHtml({
      userId: "u1",
      displayName: '"><script>alert(1)</script>',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("HTML-escapes hostile avatarUrl content even though scheme passed", () => {
    const html = avatarHtml({
      userId: "u1",
      displayName: "Alice",
      avatarUrl: 'https://e.com/"><img src=x onerror=alert(1)>.png',
    });
    expect(html).not.toContain('"><img src=x onerror=');
    expect(html).toContain("&quot;");
  });

  test("size and shape control the rendered style", () => {
    const html = avatarHtml({ userId: "u1", size: 64, shape: "rounded" });
    expect(html).toContain("width:64px");
    expect(html).toContain("height:64px");
    expect(html).toContain("border-radius:20%");
  });

  test("title falls back to userId when displayName is missing", () => {
    const html = avatarHtml({ userId: "user-42" });
    expect(html).toContain('title="user-42"');
  });

  test("paints the deterministic background only on the no-image fallback path", () => {
    const fallback = avatarHtml({ userId: "u1", displayName: "Alice" });
    expect(fallback).toContain(`background:${avatarColor("u1")}`);
    expect(fallback).toContain(`color:${avatarTextColor("u1")}`);

    const withImg = avatarHtml({
      userId: "u1",
      displayName: "Alice",
      avatarUrl: "https://cdn.example.com/a.png",
    });
    // Wrapper must be transparent so transparent PNGs composite on the parent
    // surface instead of bleeding through to the deterministic hue.
    expect(withImg).toContain("background:transparent");
    expect(withImg).not.toContain(`background:${avatarColor("u1")}`);
  });

  test("hides the initial fallback during image load", () => {
    const html = avatarHtml({
      userId: "u1",
      displayName: "Alice",
      avatarUrl: "https://cdn.example.com/a.png",
    });
    expect(html).toMatch(/<span style="display:none">A<\/span>/);
  });

  test("img onerror restores the colored disk and reveals the initial", () => {
    const html = avatarHtml({
      userId: "u1",
      displayName: "Alice",
      avatarUrl: "https://cdn.example.com/a.png",
    });
    const restored = avatarColor("u1").replace(/'/g, "&#39;");
    expect(html).toContain(`this.parentElement.style.background='${restored}'`);
    expect(html).toContain("this.previousSibling.style.display=''");
    expect(html).toContain("this.remove()");
  });
});
