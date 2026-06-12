// CoView projected viewer smoke harness - DOM-free composition (CV-FOUND-9).
//
// Test-only. Composes the REAL pieces of the projected viewer chain end-to-end,
// exactly as the live components wire them, minus the JSX wrappers (which hold
// no logic of their own - see their headers):
//
//   selectCoViewViewer                  (viewer-selector.ts - the seam's choice)
//     -> createProjectedViewerMountController  (projected-viewer-mount.ts)
//          -> createProjectedFrameStore        (projected-frame-store.ts - REAL store)
//               -> resolveProjectedFrame       (render-tree-viewer.ts - the safe renderer)
//
// This is the same data path the projected branch of `CoViewViewerSelector` runs:
// the Match arm mounts `CoViewProjectedViewerMount` with `enabled: true` plus the
// forwarded store factory, the mount builds the controller, and the view resolves
// the controller's frame through `CoViewProjectedFrameView` -> `resolveProjectedFrame`.
// Nothing here is a mock - the only substitution is JSX -> a plain render() value.
// The `.tsx` counterpart (`projected-viewer-smoke-view.tsx`) typechecks the real
// component composition; this module makes the same pipeline unit-testable in the
// repo's DOM-free test environment.
//
// Dormant and production-safe: no live module imports this file, the global
// `CO_VIEW_PROJECTED_VIEWER_ENABLED` is untouched, and selection of the projected
// arm happens only through the injected `projectedEnabled` override - the same DI
// seam the selector exposes. The harness is a pure pass-through of
// already-projected frames; it synthesizes no value, so it can introduce no
// protected bytes.

import type { CoViewProjectedRenderFrame } from "@uncorded/protocol";

import {
  createProjectedFrameStore,
  type ProjectedFrameStore,
} from "./projected-frame-store";
import {
  createProjectedViewerMountController,
  type ProjectedViewerMountController,
} from "./projected-viewer-mount";
import { resolveProjectedFrame, type SafeViewFrame } from "./render-tree-viewer";
import { selectCoViewViewer, type CoViewViewerChoice } from "./viewer-selector";

export class ProjectedViewerSmokeError extends Error {
  readonly code: "ERR_PROJECTED_VIEWER_SMOKE_LEGACY_DELIVERY";
  readonly context: { readonly serverId: string; readonly sessionId: string };

  constructor(context: { serverId: string; sessionId: string }) {
    super("cannot deliver a projected frame on the legacy viewer arm");
    this.name = "ProjectedViewerSmokeError";
    this.code = "ERR_PROJECTED_VIEWER_SMOKE_LEGACY_DELIVERY";
    this.context = context;
  }
}

/** Inputs mirror `CoViewViewerSelectorProps`' selection-relevant subset. */
export interface ProjectedViewerSmokeArgs {
  serverId: string;
  sessionId: string;
  /**
   * The DI override forwarded to `selectCoViewViewer` - identical semantics to
   * the selector's `projectedEnabled` prop. Left undefined it falls back to the
   * (false) global flag, so the harness defaults to the legacy arm exactly like
   * production.
   */
  projectedEnabled?: boolean | undefined;
}

/**
 * What the composed viewer renders for a session - a plain-value mirror of the
 * component tree's three terminal states:
 *   - `legacy`  : the selector's Switch fallback (`ViewerSession`) - the
 *                 projected path constructed nothing.
 *   - `pending` : the projected mount is live but no frame is stored for the
 *                 session - the bytes-free pending placeholder renders.
 *   - `frame`   : the stored frame, resolved through the REAL safe renderer
 *                 (`resolveProjectedFrame`, exactly what `CoViewProjectedFrameView`
 *                 runs).
 */
export type ProjectedViewerSmokeRender =
  | { kind: "legacy" }
  | { kind: "pending" }
  | { kind: "frame"; safe: SafeViewFrame };

/** The composed smoke harness over the real selector/mount/store/renderer chain. */
export interface ProjectedViewerSmokeHarness {
  /** The real selector's choice for the given args. */
  choice: CoViewViewerChoice;
  /** serverIds the store factory was invoked with ([] on the legacy arm). */
  storesCreatedFor: readonly string[];
  /** Latest stored projected frame for a session (always undefined on legacy). */
  frame: (sessionId: string) => CoViewProjectedRenderFrame | undefined;
  /**
   * Deliver an envelope through the REAL store's apply path - the same
   * `applyProjectedFrame`/commit code the WS observer callback runs. Throws on
   * the legacy arm, where no store exists to receive anything.
   */
  deliver: (envelope: unknown) => void;
  /** Resolve what the composed viewer renders for a session right now. */
  render: (sessionId: string) => ProjectedViewerSmokeRender;
  /** Mirrors unmount (`onCleanup` -> controller.dispose -> store.dispose). */
  dispose: () => void;
}

/**
 * Compose the real projected-viewer chain for one (serverId, sessionId). The
 * legacy arm constructs nothing - matching the live selector, where the Switch
 * fallback mounts `ViewerSession` and the projected mount never instantiates.
 * The projected arm constructs the controller exactly as the Match arm does
 * (`enabled: true` + a store factory), with the factory building the REAL
 * `createProjectedFrameStore` - constructing it dials no socket (the observer
 * buffers into ws.ts's pending set), so the harness is test-safe.
 */
export function createProjectedViewerSmokeHarness(
  args: ProjectedViewerSmokeArgs,
): ProjectedViewerSmokeHarness {
  const choice = selectCoViewViewer({
    serverId: args.serverId,
    sessionId: args.sessionId,
    enabled: args.projectedEnabled,
  });

  const storesCreatedFor: string[] = [];
  let store: ProjectedFrameStore | undefined;
  let controller: ProjectedViewerMountController | undefined;

  if (choice.kind === "projected") {
    // Mirrors the selector's Match arm: the mount receives `enabled: true` plus
    // the forwarded factory, and the controller constructs exactly one store.
    controller = createProjectedViewerMountController(choice.serverId, {
      enabled: true,
      createStore: (serverId) => {
        storesCreatedFor.push(serverId);
        store = createProjectedFrameStore(serverId);
        return store;
      },
    });
  }

  return {
    choice,
    storesCreatedFor,
    frame: (sessionId) => controller?.frame(sessionId),
    deliver: (envelope) => {
      if (!store) {
        throw new ProjectedViewerSmokeError({
          serverId: args.serverId,
          sessionId: args.sessionId,
        });
      }
      store.apply(envelope);
    },
    render: (sessionId) => {
      // The Switch fallback: legacy `ViewerSession`, projected path inert.
      if (!controller) return { kind: "legacy" };
      const frame = controller.frame(sessionId);
      // The mount's Show fallback: bytes-free pending placeholder, never stale.
      if (!frame) return { kind: "pending" };
      // `CoViewProjectedFrameView`'s exact resolution of the stored frame.
      return { kind: "frame", safe: resolveProjectedFrame(frame) };
    },
    dispose: () => controller?.dispose(),
  };
}
