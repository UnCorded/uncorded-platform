import { describe, expect, test } from "bun:test";
import {
  proxyStatusBadgeClass,
  proxyStatusLabel,
  proxyWarningText,
} from "./proxy-mount-status";

describe("proxyStatusLabel", () => {
  test("maps every status to a distinct label", () => {
    expect(proxyStatusLabel("approved")).toBe("Approved");
    expect(proxyStatusLabel("pending")).toBe("Pending approval");
    expect(proxyStatusLabel("drifted")).toBe("Needs re-approval");
    expect(proxyStatusLabel("invalid")).toBe("Invalid upstream");
  });
});

describe("proxyStatusBadgeClass", () => {
  test("approved is positive, invalid is destructive, pending/drifted warn", () => {
    expect(proxyStatusBadgeClass("approved")).toContain("emerald");
    expect(proxyStatusBadgeClass("invalid")).toContain("destructive");
    expect(proxyStatusBadgeClass("pending")).toContain("amber");
    expect(proxyStatusBadgeClass("drifted")).toContain("amber");
  });
});

describe("proxyWarningText", () => {
  test("returns a non-empty explanation for each advisory", () => {
    for (const w of [
      "loopback",
      "docker-internal",
      "rfc1918",
      "link-local",
      "unique-local",
      "cgnat",
      "mdns",
    ] as const) {
      expect(proxyWarningText(w).length).toBeGreaterThan(0);
    }
  });
});
