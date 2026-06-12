// CoView viewer selector - thin Solid component (CV-FOUND-8).
//
// The live integration seam: sits where App.tsx used to mount `ViewerSession`
// directly, and renders either the legacy viewer or the dormant projected mount
// based on `selectCoViewViewer`. It holds no logic of its own - the selector
// decides; this component only maps that choice onto JSX. NOT live-wired to the
// projected arm in production: with `projectedEnabled` undefined the selector falls
// back to `CO_VIEW_PROJECTED_VIEWER_ENABLED` (false), so the legacy `ViewerSession`
// renders exactly as before. Like `render-tree-viewer-view.tsx` /
// `projected-viewer-mount-view.tsx`, this `.tsx` is covered by typecheck only; its
// selection logic is unit-tested through `selectCoViewViewer` in
// `viewer-selector.test.ts`.

import { Match, Switch, type JSX } from "solid-js";

import { CoViewProjectedViewerMount } from "./projected-viewer-mount-view";
import type { ProjectedFrameStoreFactory } from "./projected-viewer-mount";
import { ViewerSession, type ViewerSessionProps } from "./viewer-session";
import { selectCoViewViewer } from "./viewer-selector";

export interface CoViewViewerSelectorProps extends ViewerSessionProps {
  /**
   * Override the dormancy flag for the projected viewer. Left undefined at the live
   * call site so `selectCoViewViewer` falls back to `CO_VIEW_PROJECTED_VIEWER_ENABLED`
   * (false) and the legacy viewer renders; tests pass `true` to exercise the
   * projected arm.
   */
  projectedEnabled?: boolean;
  /** Store factory forwarded to the projected mount (tests). */
  createStore?: ProjectedFrameStoreFactory;
}

/**
 * Choose and mount the CoView viewer for one session. Default / flag-off resolves to
 * the legacy `ViewerSession` (byte-identical to mounting it directly). When the
 * projected arm is selected it mounts `CoViewProjectedViewerMount`, which passes only
 * already-projected frames through - this seam forwards just `serverId` / `sessionId`
 * and never touches frame data, so it introduces no protected bytes.
 */
export function CoViewViewerSelector(props: CoViewViewerSelectorProps): JSX.Element {
  const choice = () =>
    selectCoViewViewer({
      serverId: props.serverId,
      sessionId: props.sessionId,
      enabled: props.projectedEnabled,
    });

  return (
    <Switch fallback={<ViewerSession {...props} />}>
      <Match when={choice().kind === "projected"}>
        <CoViewProjectedViewerMount
          serverId={props.serverId}
          sessionId={props.sessionId}
          enabled={true}
          // Forward the store factory only when provided - passing an explicit
          // `undefined` would violate `exactOptionalPropertyTypes` on the mount's
          // optional `createStore` prop.
          {...(props.createStore ? { createStore: props.createStore } : {})}
        />
      </Match>
    </Switch>
  );
}
