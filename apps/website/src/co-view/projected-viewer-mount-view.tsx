// CoView projected viewer mount - thin Solid component (CV-FOUND-7).
//
// Declarative wrapper over `createProjectedViewerMountController`: connects
// `createProjectedFrameStore(serverId)` -> latest frame for `sessionId` ->
// `CoViewProjectedFrameView`. It holds no logic of its own - the controller
// decides whether the path is live and reads the frame; this component only maps
// that onto JSX and ties store disposal to unmount via `onCleanup`.
//
// Dormant by default: with `CO_VIEW_PROJECTED_VIEWER_ENABLED` false the controller
// is inert and this renders `null`, so no live production UI mounts the projected
// viewer. The next CV-FOUND PR flips the flag (or passes `enabled`) to bring it
// live. NOT live-wired here - like `render-tree-viewer-view.tsx`, this `.tsx` is
// covered by typecheck only; its wiring logic is unit-tested through the
// controller in `projected-viewer-mount.test.ts`.

import { Show, onCleanup, type JSX } from "solid-js";

import {
  createProjectedViewerMountController,
  type ProjectedFrameStoreFactory,
} from "./projected-viewer-mount";
import { CoViewProjectedFrameView } from "./render-tree-viewer-view";

export interface CoViewProjectedViewerMountProps {
  /** Server whose projected frames to receive. */
  serverId: string;
  /** CoView session to mirror; selects which stored frame mounts. */
  sessionId: string;
  /**
   * Override the dormancy flag. Defaults to `CO_VIEW_PROJECTED_VIEWER_ENABLED`
   * (false); the enabling PR / tests pass `true`.
   */
  enabled?: boolean;
  /** Override the store factory (tests). */
  createStore?: ProjectedFrameStoreFactory;
}

/**
 * Mount the sanitized projected viewer for one CoView session. Renders nothing
 * while dormant; once live, shows `CoViewProjectedFrameView` for the latest
 * stored frame and a bytes-free placeholder while none has arrived. The frame read
 * is reactive on `sessionId`, so switching sessions shows that session's frame (or
 * the placeholder) - never the previous session's stale content.
 */
export function CoViewProjectedViewerMount(
  props: CoViewProjectedViewerMountProps,
): JSX.Element {
  const controller = createProjectedViewerMountController(props.serverId, {
    enabled: props.enabled,
    createStore: props.createStore,
  });
  // Dormant: the controller built no store, so there is nothing to mount or clean
  // up. Returning null here keeps the projected path out of the live tree.
  if (!controller.active) return null;

  onCleanup(() => controller.dispose());

  const frame = () => controller.frame(props.sessionId);
  return (
    <Show
      when={frame()}
      fallback={
        <div
          class="coview-projected-mount-pending"
          data-coview-projected-mount="pending"
          aria-hidden="true"
        />
      }
    >
      {(current) => <CoViewProjectedFrameView frame={current()} />}
    </Show>
  );
}
