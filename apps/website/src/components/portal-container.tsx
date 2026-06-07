// <PortalContainer /> — the single top-level parent for all portal-hosted
// iframes and webviews. Must be mounted exactly once, at App root, BEFORE any
// panel content that would register a mount.
//
// Z-index scale (validated against the audit in apps/website/src — dialogs,
// dropdowns, sheets, tooltips all sit at z-50; panel resize handle at z-10;
// panel rearrange overlay at z-30):
//
//   placeholder DOM         (in-tree)   : 0
//   panel resize handle     (in-tree)   : 10   (panel.tsx:549)
//   panel edge preview      (in-tree)   : 10   (panel.tsx:351)
//   panel rearrange overlay (in-tree)   : 30   (panel.tsx:362)
//   portal iframes (normal)             : 40
//   portal iframes (floating drag ghost): 45
//   modals / sheets / dropdowns         : 50   (Kobalte portal defaults + ui/*)
//   toast / inline status               : 60
//
// The portal sits above the resize handle and rearrange overlay so the
// iframe is fully interactive during normal use. During resize and drag,
// individual mounts set pointer-events: none so the in-tree hit targets
// underneath receive the gesture.
//
// Clip-path tracking: SidebarInset has `rounded-xl overflow-hidden` in inset
// mode (ui/sidebar.tsx:305), which clips in-tree panel placeholders to a
// rounded rectangle. Portaled iframes live in this container (a sibling of
// SidebarInset, not a child), so they bypass that clip — straight iframe
// edges poke over SidebarInset's rounded corners. We mirror SidebarInset's
// geometry onto this container via a dynamic `clip-path`. Tracked via RO
// (sidebar collapse changes inset width), window resize, and a short
// transition-driven poll to cover the 200ms sidebar collapse animation.

import { onMount, onCleanup } from "solid-js";
import { registerPortalRoot, unregisterPortalRoot } from "@/lib/portal-host";

export function PortalContainer() {
  let rootRef!: HTMLDivElement;

  onMount(() => {
    registerPortalRoot(rootRef);

    let rafHandle: number | null = null;
    let pollUntil = 0;

    // Compose a `clip-path: inset(...)` string mirroring SidebarInset's rect
    // + border-radius. Falls back to no clip if the inset isn't present (e.g.
    // pre-mount or in unauthenticated state where the panel tree isn't rendered).
    const updateClip = () => {
      const inset = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]');
      if (inset === null) {
        rootRef.style.clipPath = "none";
        return;
      }
      const r = inset.getBoundingClientRect();
      const cs = window.getComputedStyle(inset);
      // All four corners read independently because Tailwind's `rounded-xl`
      // may be applied per-corner depending on breakpoint / sidebar state.
      const tl = cs.borderTopLeftRadius;
      const tr = cs.borderTopRightRadius;
      const br = cs.borderBottomRightRadius;
      const bl = cs.borderBottomLeftRadius;
      const top = r.top;
      const right = window.innerWidth - r.right;
      const bottom = window.innerHeight - r.bottom;
      const left = r.left;
      rootRef.style.clipPath =
        `inset(${top}px ${right}px ${bottom}px ${left}px round ${tl} ${tr} ${br} ${bl})`;
    };

    // rAF loop active during the polling window — covers the sidebar's
    // 200ms collapse transition, where RO fires but the rect changes per-frame.
    const pollTick = () => {
      updateClip();
      if (performance.now() < pollUntil) {
        rafHandle = requestAnimationFrame(pollTick);
      } else {
        rafHandle = null;
      }
    };

    const kickPoll = (durationMs: number) => {
      pollUntil = Math.max(pollUntil, performance.now() + durationMs);
      if (rafHandle === null) {
        rafHandle = requestAnimationFrame(pollTick);
      }
    };

    updateClip();

    // Initial observer setup. `inset` may not exist yet (unauthenticated state);
    // in that case a MutationObserver on <body> rewires once it appears.
    let ro: ResizeObserver | null = null;
    const attachRo = () => {
      const inset = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]');
      if (inset === null || ro !== null) return;
      ro = new ResizeObserver(() => kickPoll(260));
      ro.observe(inset);
      updateClip();
    };
    attachRo();

    // SidebarInset mounts/unmounts across auth flow and server-switch states,
    // so watch for DOM additions.
    const mo = new MutationObserver(() => {
      const inset = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]');
      if (inset === null && ro !== null) {
        ro.disconnect();
        ro = null;
        updateClip();
        return;
      }
      if (inset !== null && ro === null) attachRo();
    });
    mo.observe(document.body, { childList: true, subtree: true });

    const onResize = () => kickPoll(260);
    window.addEventListener("resize", onResize);

    onCleanup(() => {
      unregisterPortalRoot(rootRef);
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
      if (ro !== null) ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", onResize);
    });
  });

  return (
    <div
      ref={rootRef}
      data-portal-host="iframes"
      style={{
        position: "fixed",
        inset: "0",
        // Pointer events pass through the container itself — only the absolutely
        // positioned children receive events (each child sets its own pointer-events).
        "pointer-events": "none",
        "z-index": "40",
        // Contain layout + paint so overflow doesn't leak through to parent scroll.
        overflow: "hidden",
      }}
    />
  );
}
