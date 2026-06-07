// Iframe-focus dismissal bridge for Kobalte popovers.
//
// The problem
// -----------
// When the user clicks inside a sandboxed cross-origin <iframe> or Electron
// <webview>, the click is dispatched in that frame's own browsing context.
// The parent document never sees a `pointerdown` event for it, so Kobalte's
// "click outside" detector (createInteractOutside, capture-phase pointerdown
// on the parent document) is blind — and any open DropdownMenu / ContextMenu
// / Popover stays open, which feels broken.
//
// We can't detect the click in the parent: cross-origin sandboxed iframes
// and Electron webviews intentionally hide pointer events, focus events, and
// activeElement updates from the host (this is by design — it's the same
// site-isolation that prevents a malicious frame from spying on the host).
// Three detection-based attempts (window.blur, focusin, activeElement
// polling) all failed on real Electron + sandboxed iframe content.
//
// The fix
// -------
// Instead of detecting the click, *redirect* it. While any popover is open,
// add `pointer-events: none` to all iframes and webviews. Clicks on those
// elements pass through to whatever is painted behind them — in our layout
// that's the panel body placeholder (an in-tree <div>), which IS in the
// parent document. Kobalte's pointerdown listener sees it, runs the normal
// isEventOutside path, and dismisses the popover.
//
// The user has to click twice — first click dismisses the popover, second
// click reaches the iframe. This matches native menu behavior on macOS and
// Windows: a click outside a menu always dismisses the menu and is
// considered consumed.
//
// We toggle via a single body class (`data-uc-popover-open`) backed by an
// injected <style> rule using `!important`. That outranks the inline
// `pointer-events` styles `panel.tsx` sets during resize, so a popover open
// during a resize cleanly wins (the resize gesture wouldn't make sense
// during an open menu anyway).
//
// We watch `[data-expanded]` (Kobalte's open-state marker, set on both the
// trigger and the portaled content) with a MutationObserver to know when
// any popover opens or closes. The observer is the single source of truth
// for the body class — no per-component wiring required.

const BODY_FLAG_ATTR = "data-uc-popover-open";
const STYLE_TAG_ID = "uc-iframe-shield-style";

let installed = false;

function ensureStyleTag(): void {
  if (document.getElementById(STYLE_TAG_ID) !== null) return;
  const style = document.createElement("style");
  style.id = STYLE_TAG_ID;
  // !important to outrank `panel.tsx`'s inline `pointer-events` styles.
  // Scoped to descendants of body[data-uc-popover-open] so it's a no-op
  // whenever no popover is open.
  style.textContent =
    `body[${BODY_FLAG_ATTR}] iframe, body[${BODY_FLAG_ATTR}] webview ` +
    `{ pointer-events: none !important; }`;
  document.head.appendChild(style);
}

export function installIframeFocusDismiss(): () => void {
  if (installed) return () => {};
  installed = true;

  ensureStyleTag();

  const updateState = (): void => {
    const hasOpen = document.querySelector("[data-expanded]") !== null;
    if (hasOpen) document.body.setAttribute(BODY_FLAG_ATTR, "");
    else document.body.removeAttribute(BODY_FLAG_ATTR);
  };

  // Watch for [data-expanded] appearing or disappearing anywhere in body.
  // Kobalte sets this on both the trigger element and the portaled content;
  // either presence is enough to mean "a popover is open".
  const mo = new MutationObserver(updateState);
  mo.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-expanded"],
  });

  // Defensive initial sync — App.onMount runs before any user interaction
  // normally, so this should always be a no-op, but it costs nothing.
  updateState();

  return () => {
    mo.disconnect();
    document.body.removeAttribute(BODY_FLAG_ATTR);
    installed = false;
  };
}
