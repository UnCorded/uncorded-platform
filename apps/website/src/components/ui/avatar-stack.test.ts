import { describe, expect, test } from "bun:test";
import { buildOverflowLabel, safeAvatarUrl } from "./avatar-stack-helpers";

describe("safeAvatarUrl", () => {
  test("accepts http(s) URLs unchanged", () => {
    expect(safeAvatarUrl("https://example.com/a.png")).toBe(
      "https://example.com/a.png",
    );
    expect(safeAvatarUrl("http://cdn.local/b.jpg")).toBe(
      "http://cdn.local/b.jpg",
    );
    expect(safeAvatarUrl("HTTPS://EXAMPLE.COM/A.PNG")).toBe(
      "HTTPS://EXAMPLE.COM/A.PNG",
    );
  });

  test("rejects javascript:, data:, relative, and protocol-relative URLs", () => {
    expect(safeAvatarUrl("javascript:alert(1)")).toBeNull();
    expect(safeAvatarUrl("data:image/png;base64,xxx")).toBeNull();
    expect(safeAvatarUrl("/local/a.png")).toBeNull();
    expect(safeAvatarUrl("//cdn.example.com/a.png")).toBeNull();
    expect(safeAvatarUrl("ftp://example.com/a.png")).toBeNull();
  });

  test("rejects null, undefined, and non-string input", () => {
    expect(safeAvatarUrl(null)).toBeNull();
    expect(safeAvatarUrl(undefined)).toBeNull();
    // @ts-expect-error — runtime guard
    expect(safeAvatarUrl(42)).toBeNull();
    // @ts-expect-error — runtime guard
    expect(safeAvatarUrl({})).toBeNull();
  });
});

describe("buildOverflowLabel", () => {
  test("joins hidden names with comma+space", () => {
    expect(
      buildOverflowLabel(
        [{ name: "Alice" }, { name: "Bob" }, { name: "Carol" }],
        3,
      ),
    ).toBe("Alice, Bob, Carol");
  });

  test("trims whitespace from names", () => {
    expect(
      buildOverflowLabel([{ name: "  Alice  " }, { name: "\tBob\n" }], 2),
    ).toBe("Alice, Bob");
  });

  test("filters out empty / whitespace-only / undefined names", () => {
    expect(
      buildOverflowLabel(
        [{ name: "Alice" }, { name: "   " }, { name: "" }, {}],
        4,
      ),
    ).toBe("Alice");
  });

  test("falls back to '<N> more' when no usable names remain", () => {
    expect(buildOverflowLabel([{}, { name: "" }, { name: "  " }], 3)).toBe(
      "3 more",
    );
    expect(buildOverflowLabel([], 0)).toBe("0 more");
  });
});
