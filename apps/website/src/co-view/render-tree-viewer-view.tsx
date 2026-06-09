// CoView projected render-tree viewer — SolidJS view component (CV-FOUND-5).
//
// A thin, declarative map from the safe view model produced by
// `render-tree-viewer.ts` onto the DOM. It holds NO security logic: every
// privacy/sanitization decision was already made in the pure layer, and this
// component only ever emits the three allowlisted tags with the allowlisted
// attributes. There is no `innerHTML`, no `src`/`href`, and no event handlers —
// the mirror is presentational, so a control renders but cannot be executed.
//
// NOT live-wired. Exported for the next CV-FOUND PR to mount behind
// `CO_VIEW_PROJECTED_VIEWER_ENABLED`.

import { For, Show, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";

import { cn } from "../lib/utils";
import {
  resolveProjectedFrame,
  type SafeViewFrame,
  type SafeViewNode,
} from "./render-tree-viewer";
import type { CoViewProjectedRenderFrame } from "@uncorded/protocol";

/** Render one resolved safe view node and its subtree. */
function SafeNodeView(props: { node: SafeViewNode }) {
  const node = () => props.node;
  const content = () => node().content;
  return (
    <Dynamic
      component={node().tag}
      class={cn("coview-node", ...node().classTokens)}
      data-coview-id={node().id}
      data-coview-kind={node().kind}
      data-coview-control={node().controlKind}
      role={node().aria.role as JSX.HTMLAttributes<HTMLElement>["role"]}
      aria-expanded={node().aria.expanded}
      aria-checked={node().aria.checked}
      aria-disabled={node().state.disabled || undefined}
      data-hovered={node().state.hovered || undefined}
      data-focused={node().state.focused || undefined}
      data-pressed={node().state.pressed || undefined}
      data-selected={node().state.selected || undefined}
      data-open={node().state.open || undefined}
      type={node().tag === "button" ? "button" : undefined}
      tabIndex={node().tag === "button" ? -1 : undefined}
      disabled={node().tag === "button" ? true : undefined}
    >
      <Show when={content().kind === "text" ? content() : null}>
        {(c) => <>{(c() as { kind: "text"; text: string }).text}</>}
      </Show>
      <Show when={content().kind === "placeholder" ? content() : null}>
        {(c) => {
          const ph = (c() as Extract<SafeViewNode["content"], { kind: "placeholder" }>).placeholder;
          return (
            <span
              class={cn("coview-placeholder", `coview-placeholder--${ph.reason}`)}
              data-coview-placeholder={ph.reason}
              data-coview-placeholder-mode={ph.mode}
              data-coview-placeholder-width={ph.width}
              data-coview-placeholder-height={ph.height}
              data-coview-placeholder-lines={ph.lines}
              aria-hidden="true"
            />
          );
        }}
      </Show>
      <For each={node().children}>{(child) => <SafeNodeView node={child} />}</For>
    </Dynamic>
  );
}

/**
 * Render a resolved safe view frame. Prefer this overload when the caller has
 * already projected the frame (e.g. to inspect it first).
 */
export function CoViewProjectedTreeView(props: { frame: SafeViewFrame }) {
  return <SafeNodeView node={props.frame.root} />;
}

/**
 * Convenience entry point: resolve a raw projected frame and render it. The
 * resolution is pure and re-run reactively if `frame` changes.
 */
export function CoViewProjectedFrameView(props: { frame: CoViewProjectedRenderFrame }) {
  const resolved = () => resolveProjectedFrame(props.frame);
  return <CoViewProjectedTreeView frame={resolved()} />;
}
