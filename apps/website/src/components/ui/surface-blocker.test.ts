import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRoot } from "solid-js";

import { surfaceBlockersActive } from "@/lib/live-surface-host";
import { SuspendSurfacesWhileOpen } from "@/components/ui/surface-blocker";

// Regression: panel-header dropdown/context menus suspended native panel views
// for the WHOLE time their trigger was in the tree, not just while open. The
// menu wrapper called `pushSurfaceBlocker()` in its (permanently-mounted) body,
// so `surfaceBlockersActive()` was pinned true and every native Web App view
// reported visible:false — a freshly-docked panel rendered blank.
//
// The fix moves the blocker into `SuspendSurfacesWhileOpen`, rendered as a child
// of Kobalte's `*.Content` (which mounts its children only while open). These
// tests lock the contract that makes that correct: the blocker is held exactly
// for the component's mount lifetime, so a CLOSED menu (component absent) holds
// nothing.
describe("SuspendSurfacesWhileOpen", () => {
  test("holds no blocker before anything mounts", () => {
    expect(surfaceBlockersActive()).toBe(false);
  });

  test("holds a blocker only while mounted, releases on unmount", () => {
    expect(surfaceBlockersActive()).toBe(false);

    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      // Mounting the component (as a Content child does while the menu is open)
      // registers the blocker.
      SuspendSurfacesWhileOpen();
    });
    expect(surfaceBlockersActive()).toBe(true);

    // Unmounting (menu closes → Content child disposes) releases it. A closed
    // menu must leave nothing pinned.
    dispose();
    expect(surfaceBlockersActive()).toBe(false);
  });

  test("concurrent mounts stack and unwind back to unsuspended", () => {
    // Two menus open at once (e.g. a context menu over a panel with an open
    // header dropdown) → the count stacks, and suspension only lifts once BOTH
    // have closed. Guards the count arithmetic against an off-by-one leak.
    expect(surfaceBlockersActive()).toBe(false);

    let disposeA!: () => void;
    let disposeB!: () => void;
    createRoot((d) => {
      disposeA = d;
      SuspendSurfacesWhileOpen();
    });
    createRoot((d) => {
      disposeB = d;
      SuspendSurfacesWhileOpen();
    });
    expect(surfaceBlockersActive()).toBe(true);

    disposeA();
    expect(surfaceBlockersActive()).toBe(true); // one still open

    disposeB();
    expect(surfaceBlockersActive()).toBe(false); // both closed → restored
  });
});

// Regression (second instance of the same leak class): dialog.tsx/sheet.tsx
// called `pushSurfaceBlocker()` in their Content WRAPPER body, assuming the
// wrapper mounts only while open. Wrong: a Solid component function runs
// eagerly when its parent renders it — Kobalte's conditional mounting starts
// at its Portal, INSIDE the wrapper's return value. Every always-mounted
// <Dialog>/<Sheet> root (9 in the app shell) therefore pinned a blocker from
// startup, and every docked live view reported visible:false (blank panels).
//
// Kobalte mount semantics can't be exercised here (no DOM in this harness), so
// lock the rule at the source level instead: no UI primitive may reference raw
// `pushSurfaceBlocker` — suspension must go through <SuspendSurfacesWhileOpen />
// rendered as a `*.Content` CHILD, whose mount lifetime is provably open-scoped
// (tests above).
describe("ui primitives use SuspendSurfacesWhileOpen, never raw pushSurfaceBlocker", () => {
  test("no components/ui module references pushSurfaceBlocker", () => {
    const uiDir = import.meta.dir;
    const offenders = readdirSync(uiDir)
      .filter((name) => name.endsWith(".tsx") && name !== "surface-blocker.tsx")
      .filter((name) => readFileSync(join(uiDir, name), "utf8").includes("pushSurfaceBlocker"));
    expect(offenders).toEqual([]);
  });
});
