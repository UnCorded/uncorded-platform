import { onCleanup } from "solid-js";
import { pushSurfaceBlocker } from "@/lib/live-surface-host";

// Suspends native panel views (live WebContentsViews paint ABOVE all DOM) for as
// long as THIS component is mounted, then releases on cleanup.
//
// Render it as a CHILD of a Kobalte `*.Content`, never in the wrapper body. A
// Kobalte Content mounts its children only while open (its internal
// `<Show when={contentPresent()}>`), so a child here is scoped to the open
// lifetime. Calling `pushSurfaceBlocker()` directly in a wrapper body is a leak
// whenever the wrapper itself is always mounted — which is the NORMAL case:
// Solid component functions run eagerly when their parent renders them, and
// Kobalte's conditional mounting starts at its Portal, inside the wrapper's
// return value. This bit twice: panel-header dropdown/context menus, then
// DialogContent/SheetContent (9 always-mounted roots in the app shell pinned
// suspension from startup → every docked live view blank). A source-level test
// in surface-blocker.test.ts forbids raw pushSurfaceBlocker in components/ui.
export function SuspendSurfacesWhileOpen() {
  onCleanup(pushSurfaceBlocker());
  return null;
}
