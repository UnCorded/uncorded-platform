// Projected CoView viewer dev-flag tests (CV-FOUND-11).
//
// The testable substance is the pure resolver (`resolveProjectedViewerDevEnabled`)
// with all environment inputs injected - no `import.meta.env` mocking, no
// localStorage shimming (the `viewer-selector.ts` / `.tsx` split pattern). The
// live wrapper (`isProjectedViewerDevEnabled`) is additionally sanity-checked
// under the test runner, where no override is present, to prove the wired
// default is `false`.
//
// Coverage:
//   - Fail-closed default: no override anywhere -> false (production legacy).
//   - Env channel: exactly "1" enables; "true"/"0"/""/undefined do not.
//   - localStorage channel: "1" enables ONLY in dev mode; the same value on a
//     production build is ignored entirely.
//   - The global dormancy flag is untouched (still false).
//   - Composition with `selectCoViewViewer`: resolver-default -> legacy;
//     resolver with an override present -> projected.

import { describe, expect, test } from "bun:test";

import {
  isProjectedViewerDevEnabled,
  resolveProjectedViewerDevEnabled,
  type ProjectedViewerDevFlagInputs,
} from "./projected-viewer-dev-flag";
import { selectCoViewViewer } from "./viewer-selector";
import { CO_VIEW_PROJECTED_VIEWER_ENABLED } from "./render-tree-viewer";

/** Baseline: a stock production build with no override anywhere. */
const PROD_DEFAULTS: ProjectedViewerDevFlagInputs = {
  envFlag: undefined,
  isDev: false,
  localStorageFlag: null,
};

// --- fail-closed default -----------------------------------------------------

describe("resolveProjectedViewerDevEnabled - fail-closed default", () => {
  test("no override anywhere resolves to false", () => {
    expect(resolveProjectedViewerDevEnabled(PROD_DEFAULTS)).toBe(false);
  });

  test("dev mode alone (no flag set) resolves to false", () => {
    expect(resolveProjectedViewerDevEnabled({ ...PROD_DEFAULTS, isDev: true })).toBe(false);
  });

  test("the global dormancy flag stays untouched (false)", () => {
    expect(CO_VIEW_PROJECTED_VIEWER_ENABLED).toBe(false);
  });
});

// --- env channel ---------------------------------------------------------------

describe("resolveProjectedViewerDevEnabled - env flag channel", () => {
  test('envFlag "1" enables, even outside dev mode (explicit dogfood build)', () => {
    expect(resolveProjectedViewerDevEnabled({ ...PROD_DEFAULTS, envFlag: "1" })).toBe(true);
  });

  test("only the exact string \"1\" counts", () => {
    for (const value of ["true", "0", "", "yes", "ON", " 1"]) {
      expect(resolveProjectedViewerDevEnabled({ ...PROD_DEFAULTS, envFlag: value })).toBe(false);
    }
  });
});

// --- localStorage channel (dev-gated) -----------------------------------------

describe("resolveProjectedViewerDevEnabled - localStorage channel", () => {
  test('dev mode + localStorage "1" enables', () => {
    expect(
      resolveProjectedViewerDevEnabled({ envFlag: undefined, isDev: true, localStorageFlag: "1" }),
    ).toBe(true);
  });

  test('localStorage "1" is IGNORED outside dev mode (production build)', () => {
    expect(
      resolveProjectedViewerDevEnabled({ envFlag: undefined, isDev: false, localStorageFlag: "1" }),
    ).toBe(false);
  });

  test("in dev mode, only the exact string \"1\" counts", () => {
    for (const value of ["true", "0", "", null]) {
      expect(
        resolveProjectedViewerDevEnabled({ envFlag: undefined, isDev: true, localStorageFlag: value }),
      ).toBe(false);
    }
  });
});

// --- live wrapper --------------------------------------------------------------

describe("isProjectedViewerDevEnabled - live wrapper", () => {
  test("returns false under the test runner (no override present)", () => {
    // The test process sets neither VITE_UNCORDED_COVIEW_PROJECTED_VIEWER nor a
    // Vite dev `DEV === true`, and Bun has no localStorage - so the wired
    // default the live call site passes to the selector is `false`.
    expect(isProjectedViewerDevEnabled()).toBe(false);
  });
});

// --- composition with the viewer selector ---------------------------------------

describe("dev flag -> selectCoViewViewer integration", () => {
  test("resolver default keeps the live flow on the legacy viewer", () => {
    const enabled = resolveProjectedViewerDevEnabled(PROD_DEFAULTS);
    const choice = selectCoViewViewer({ serverId: "srv", sessionId: "A", enabled });
    expect(choice).toEqual({ kind: "legacy" });
  });

  test("env override flows through to the projected arm", () => {
    const enabled = resolveProjectedViewerDevEnabled({ ...PROD_DEFAULTS, envFlag: "1" });
    const choice = selectCoViewViewer({ serverId: "srv-1", sessionId: "sess-7", enabled });
    expect(choice).toEqual({ kind: "projected", serverId: "srv-1", sessionId: "sess-7" });
  });

  test("dev localStorage override flows through to the projected arm", () => {
    const enabled = resolveProjectedViewerDevEnabled({
      envFlag: undefined,
      isDev: true,
      localStorageFlag: "1",
    });
    const choice = selectCoViewViewer({ serverId: "srv", sessionId: "B", enabled });
    expect(choice).toEqual({ kind: "projected", serverId: "srv", sessionId: "B" });
  });
});
