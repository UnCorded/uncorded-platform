// Active-state store tests — per-server isolation + setter behavior.

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";

import {
  coViewHostingPaused,
  coViewHostingSessionId,
  coViewViewingSessionId,
  setCoViewHosting,
  setCoViewHostingPaused,
  setCoViewViewing,
} from "./active-state";

describe("active-state", () => {
  test("returns null/false defaults for an unknown server", () => {
    createRoot((dispose) => {
      expect(coViewHostingSessionId("brand-new-server")).toBe(null);
      expect(coViewHostingPaused("brand-new-server")).toBe(false);
      expect(coViewViewingSessionId("brand-new-server")).toBe(null);
      dispose();
    });
  });

  test("setCoViewHosting writes and clears per server", () => {
    createRoot((dispose) => {
      setCoViewHosting("srv-A", "sess-1");
      expect(coViewHostingSessionId("srv-A")).toBe("sess-1");
      setCoViewHosting("srv-A", null);
      expect(coViewHostingSessionId("srv-A")).toBe(null);
      dispose();
    });
  });

  test("clearing hosting also resets paused", () => {
    createRoot((dispose) => {
      setCoViewHosting("srv-A", "sess-1");
      setCoViewHostingPaused("srv-A", true);
      expect(coViewHostingPaused("srv-A")).toBe(true);
      setCoViewHosting("srv-A", null);
      expect(coViewHostingPaused("srv-A")).toBe(false);
      dispose();
    });
  });

  test("hosting state is isolated per server", () => {
    createRoot((dispose) => {
      setCoViewHosting("srv-A", "sess-A");
      setCoViewHosting("srv-B", "sess-B");
      expect(coViewHostingSessionId("srv-A")).toBe("sess-A");
      expect(coViewHostingSessionId("srv-B")).toBe("sess-B");
      setCoViewHosting("srv-A", null);
      // B unaffected by A's clear.
      expect(coViewHostingSessionId("srv-B")).toBe("sess-B");
      dispose();
    });
  });

  test("viewing state is independent of hosting state", () => {
    createRoot((dispose) => {
      setCoViewHosting("srv-A", "sess-A");
      setCoViewViewing("srv-A", "viewing-X");
      expect(coViewHostingSessionId("srv-A")).toBe("sess-A");
      expect(coViewViewingSessionId("srv-A")).toBe("viewing-X");
      setCoViewViewing("srv-A", null);
      expect(coViewHostingSessionId("srv-A")).toBe("sess-A");
      dispose();
    });
  });

  test("null serverId returns the EMPTY default", () => {
    createRoot((dispose) => {
      expect(coViewHostingSessionId(null)).toBe(null);
      expect(coViewHostingPaused(null)).toBe(false);
      expect(coViewViewingSessionId(null)).toBe(null);
      dispose();
    });
  });
});
