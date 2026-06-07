// Tests for the host controller — the bridge primitives use to push state
// into the producer (spec-27 PR-CV3).

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";

import { createCoViewHostController, useCoViewHost } from "./host-context";
import type { CoViewShellState } from "./state-schema";

function makeHarness() {
  let notifies = 0;
  const events: { kind: string; payload: Record<string, unknown>; replay?: string }[] = [];
  const { controller, getShellState } = createCoViewHostController({
    notify: () => {
      notifies += 1;
    },
    emitEvent: (kind, payload, replay) => {
      const entry: { kind: string; payload: Record<string, unknown>; replay?: string } = { kind, payload };
      if (replay !== undefined) entry.replay = replay;
      events.push(entry);
    },
  });
  return {
    controller,
    state: getShellState as () => CoViewShellState,
    notifies: () => notifies,
    events,
  };
}

describe("host controller — basics", () => {
  test("setRoute mutates state and bumps notify", () => {
    const h = makeHarness();
    h.controller.setRoute({ pathname: "/x" });
    expect(h.state().route).toEqual({ pathname: "/x" });
    expect(h.notifies()).toBe(1);
  });

  test("setWorkspace defensively clones the layouts map", () => {
    const h = makeHarness();
    const layouts = { w1: { type: "leaf" as const, id: "L1" } };
    h.controller.setWorkspace({ activeId: "w1", layouts });
    expect(h.state().workspace?.activeId).toBe("w1");
    // mutate original — state should not see it
    (layouts as Record<string, unknown>)["w2"] = { type: "leaf", id: "X" };
    expect(Object.keys(h.state().workspace?.layouts ?? {})).toEqual(["w1"]);
  });

  test("setPanelMeta sets and unsets cleanly", () => {
    const h = makeHarness();
    h.controller.setPanelMeta("L1", { visibility: "hidden" });
    expect(h.state().panelMeta?.["L1"]).toEqual({ visibility: "hidden" });
    h.controller.setPanelMeta("L1", null);
    expect(h.state().panelMeta).toBeUndefined();
  });

  // Regression for spec-27 PR-CV5: viewers were seeing dashed-box placeholders
  // because the host's panel content (slug/label/icon/url) wasn't carried in
  // shell-state. The producer now mirrors PanelContent through panelMeta so the
  // viewer can render real chrome.
  test("setPanelMeta carries optional PanelContent through", () => {
    const h = makeHarness();
    const content = {
      type: "plugin" as const,
      serverId: "srv",
      tunnelUrl: "https://srv.example",
      slug: "text-channels",
      itemId: "ch-1",
      itemLabel: "general",
      itemIcon: "#",
    };
    h.controller.setPanelMeta("L1", { visibility: "shared", content });
    expect(h.state().panelMeta?.["L1"]).toEqual({ visibility: "shared", content });
    // Replacing for a different leaf doesn't disturb the first.
    h.controller.setPanelMeta("L2", { visibility: "skeleton" });
    expect(h.state().panelMeta?.["L1"]?.content).toBeDefined();
    expect(h.state().panelMeta?.["L2"]).toEqual({ visibility: "skeleton" });
  });
});

describe("host controller — modal/popover/contextmenu stacks", () => {
  test("upsertModal appends, removeModal cleans up", () => {
    const h = makeHarness();
    h.controller.upsertModal({ id: "m1", title: "A", redacted: false });
    h.controller.upsertModal({ id: "m2", redacted: true });
    expect(h.state().modals).toHaveLength(2);

    // upsert with same id replaces
    h.controller.upsertModal({ id: "m1", title: "A2", redacted: false });
    expect(h.state().modals?.[0]?.title).toBe("A2");

    h.controller.removeModal("m1");
    h.controller.removeModal("m2");
    expect(h.state().modals).toBeUndefined();
  });

  test("popovers and context menus follow the same shape", () => {
    const h = makeHarness();
    h.controller.upsertPopover({ id: "p1", anchorId: "btn", redacted: false });
    h.controller.upsertContextMenu({ id: "c1", anchorId: "row", x: 10, y: 20 });
    expect(h.state().popovers?.[0]?.anchorId).toBe("btn");
    expect(h.state().contextMenus?.[0]?.x).toBe(10);
  });
});

describe("host controller — input shadows + scrolls + tabs", () => {
  test("setInput stores and clears", () => {
    const h = makeHarness();
    h.controller.setInput("i1", { caret: 4, valueRedacted: true });
    expect(h.state().inputs?.["i1"]).toEqual({ caret: 4, valueRedacted: true });
    h.controller.setInput("i1", null);
    expect(h.state().inputs).toBeUndefined();
  });

  test("setScroll dedupes equal positions (no notify churn)", () => {
    const h = makeHarness();
    h.controller.setScroll("s1", 100, 0);
    const first = h.notifies();
    h.controller.setScroll("s1", 100, 0); // identical — should NOT bump
    expect(h.notifies()).toBe(first);
    h.controller.setScroll("s1", 200, 0);
    expect(h.notifies()).toBe(first + 1);
  });

  test("setTab clears removed control ids", () => {
    const h = makeHarness();
    h.controller.setTab("t1", "tabA");
    expect(h.state().tabs?.["t1"]?.activeId).toBe("tabA");
    h.controller.setTab("t1", null);
    expect(h.state().tabs).toBeUndefined();
  });
});

describe("host controller — isMenuOpen", () => {
  test("false when no popovers or context menus are open", () => {
    const h = makeHarness();
    expect(h.controller.isMenuOpen()).toBe(false);
  });

  test("true while a popover is open", () => {
    const h = makeHarness();
    h.controller.upsertPopover({ id: "p1", anchorId: "btn", redacted: false });
    expect(h.controller.isMenuOpen()).toBe(true);
    h.controller.removePopover("p1");
    expect(h.controller.isMenuOpen()).toBe(false);
  });

  test("true while a context menu is open", () => {
    const h = makeHarness();
    h.controller.upsertContextMenu({ id: "c1", anchorId: "row", x: 0, y: 0 });
    expect(h.controller.isMenuOpen()).toBe(true);
    h.controller.removeContextMenu("c1");
    expect(h.controller.isMenuOpen()).toBe(false);
  });

  test("modals do NOT count as menu-open", () => {
    const h = makeHarness();
    h.controller.upsertModal({ id: "m1", redacted: false });
    expect(h.controller.isMenuOpen()).toBe(false);
  });
});

describe("host controller — emitEvent forwards", () => {
  test("forwards kind+payload+replay to deps.emitEvent", () => {
    const h = makeHarness();
    h.controller.emitEvent("nav.modal_open", { modal_id: "m1" }, "unsafe");
    expect(h.events).toEqual([
      { kind: "nav.modal_open", payload: { modal_id: "m1" }, replay: "unsafe" },
    ]);
  });
});

describe("useCoViewHost — return-shape contract (regression: spec-27 PR-CV5)", () => {
  // Regression for: viewer joining a session saw "Waiting for host state…"
  // forever because primitives evaluated `useCoViewHost()` once at mount
  // (before the host controller was published) and never re-ran. The fix is
  // to return an accessor instead of the controller value directly, so
  // primitives can call it inside `createEffect` and re-run when the host
  // appears. This test pins the contract: the export is callable and returns
  // null when no provider has supplied a controller.
  test("returns a function (accessor), not a controller value", () => {
    createRoot((dispose) => {
      const accessor = useCoViewHost();
      expect(typeof accessor).toBe("function");
      // Outside any provider, the default accessor yields null.
      expect(accessor()).toBeNull();
      dispose();
    });
  });
});
