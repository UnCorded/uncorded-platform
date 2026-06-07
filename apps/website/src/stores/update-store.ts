import { createSignal } from "solid-js";
import type { UpdateState } from "@uncorded/electron-bridge";
import { getElectron, isElectron } from "@/lib/electron";

const [updateState, setUpdateState] = createSignal<UpdateState | null>(null);
export { updateState };
export type { UpdateState };

let cleanup: (() => void) | null = null;

// Called once from App.tsx's onMount. Safe to call in browser builds —
// isElectron() short-circuits before touching the bridge, so the signal
// simply stays null and <UpdatePill /> renders nothing.
export function initUpdateStore(): void {
  if (!isElectron()) return;
  if (cleanup) return;
  const electron = getElectron();
  void electron.update.getState().then(setUpdateState);
  cleanup = electron.update.onState(setUpdateState);

  // Dev-only debug hatch for previewing pill states while auto-update is
  // `disabled` in dev (app.isPackaged=false). NOT a public API, NOT a
  // testing hook — purely so a developer can paste a synthetic state into
  // devtools. Vite strips this whole block from prod builds.
  if (import.meta.env.DEV) {
    (window as unknown as { __uncordedUpdateDebug: typeof setUpdateState })
      .__uncordedUpdateDebug = setUpdateState;
  }
}

export function disposeUpdateStore(): void {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
