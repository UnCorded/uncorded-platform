import { onCleanup } from "solid-js";
import { pushSurfaceBlocker } from "@/lib/native-surface-host";

// Suspends native panel views (live WebContentsViews paint ABOVE all DOM) for as
// long as THIS component is mounted, then releases on cleanup.
//
// Render it as a CHILD of a Kobalte `*.Content`, never in the wrapper body. A
// Kobalte menu/popover Content mounts its children only while open (its internal
// `<Show when={contentPresent()}>`), so a child here is scoped to the open
// lifetime. Calling `pushSurfaceBlocker()` directly in the wrapper body is a leak
// for components whose trigger lives permanently in the tree (panel-header
// dropdowns/context menus): the wrapper mounts once at render and never unmounts
// while the menu is closed, so the blocker is pinned and every native view stays
// hidden (blank docked Web App panels). This component closes that gap.
export function SuspendSurfacesWhileOpen() {
  onCleanup(pushSurfaceBlocker());
  return null;
}
