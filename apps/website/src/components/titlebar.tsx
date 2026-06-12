import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { Bell, Minus, Square, Copy, X, BellOff, RefreshCw, Check, Rocket } from "lucide-solid";
import { activeServer } from "@/stores/servers";
import { isElectron, getElectron } from "@/lib/electron";
import { ServerIcon } from "@/components/server-switcher";
import { updateState } from "@/stores/update-store";
import {
  notifications,
  dismissNotification,
  clearAllNotifications,
  unreadCount,
  type Notification,
} from "@/stores/notifications";

// Custom titlebar paired with Electron's frameless window. The renderer
// paints the entire bar including min/max/close so the sidebar tone can run
// edge to edge with no seam (the previous OS-painted titleBarOverlay made
// a visible color boundary in the right reservation and threw off the
// centered server pill's optical balance).
//
// Mac keeps native traffic lights via `titleBarStyle: 'hiddenInset'` — we
// only render custom controls on Win/Linux. Holding the close button for
// ~700ms opens a confirm modal that fully quits the app (parity with the
// tray's "Quit UnCorded" item); a short click hides to tray as before.
//
// No UnCorded brand chrome lives here on purpose: brand stays in the sidebar
// so collapsing the sidebar yields a brand-free "creator mode" without an
// explicit toggle (see feedback_branding_via_sidebar_collapse).

const HOLD_TO_QUIT_MS = 700;

export function Titlebar(): JSX.Element {
  if (!isElectron()) return null;

  const electron = getElectron();
  const platform = electron.app.platform;
  const isMac = platform === "darwin";
  const shortcut = isMac ? "⌘K" : "Ctrl K";

  const [confirmOpen, setConfirmOpen] = createSignal(false);
  const [notificationsOpen, setNotificationsOpen] = createSignal(false);

  // Expose the bar's height as a CSS variable so fixed-to-viewport chrome
  // (notably the Sidebar primitive's `position: fixed` rail) can offset itself
  // and not slide up underneath us. Browser builds skip Titlebar entirely, so
  // the variable stays unset and consumers fall back to 0px.
  onMount(() => {
    document.documentElement.style.setProperty("--titlebar-h", "2rem");
  });
  onCleanup(() => {
    document.documentElement.style.removeProperty("--titlebar-h");
  });

  let bellRef: HTMLButtonElement | undefined;

  return (
    <>
      <header
        class="relative flex h-8 shrink-0 items-center bg-sidebar select-none"
        style={{ "-webkit-app-region": "drag" }}
      >
        {/* Mac: reserve the traffic-light gutter on the left. Then the
            check-for-updates + bell sit right next to those native controls
            so the action cluster pairs with the window controls per design. */}
        <Show when={isMac}>
          <div class="w-[72px]" />
          <CheckUpdatesButton />
          <BellButton
            ref={(el) => (bellRef = el)}
            open={notificationsOpen()}
            onToggle={() => setNotificationsOpen((v) => !v)}
          />
        </Show>

        {/* Drag spacer fills the row so the bell + window controls can sit
            flush right (or left, on Mac). The pill is absolutely positioned
            on top of this row at true window center — see below. */}
        <div class="flex-1" />

        {/* Win/Linux: check-for-updates + bell pair with the custom window
            controls cluster. */}
        <Show when={!isMac}>
          <CheckUpdatesButton />
          <BellButton
            ref={(el) => (bellRef = el)}
            open={notificationsOpen()}
            onToggle={() => setNotificationsOpen((v) => !v)}
          />
          <WindowControls onRequestQuit={() => setConfirmOpen(true)} />
        </Show>

        {/* True-window-centered server label + shortcut chip. Absolutely
            positioned (rather than placed between two flex spacers) so the
            asymmetric weight of the right-side controls cluster doesn't drag
            the label off-center. min-width 900 + max-w-[420px] pill leaves
            comfortable clearance from the bell/controls on the right. */}
        <button
          type="button"
          class="group absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 max-w-[420px] px-1"
          style={{ "-webkit-app-region": "no-drag" }}
          data-tooltip={activeServer() ? "Search this server" : "Click to choose a server"}
          data-tooltip-side="bottom"
          onClick={() => {
            /* future: open command palette */
          }}
        >
          <Show when={activeServer()}>
            {(server) => (
              <ServerIcon
                serverId={server().id}
                name={server().name}
                tunnelUrl={server().tunnel_url ?? null}
                size="xs"
              />
            )}
          </Show>
          <span class="truncate text-sm font-medium text-sidebar-foreground/80 group-hover:text-sidebar-foreground transition-colors">
            {activeServer()?.name ?? "Choose a Server"}
          </span>
          <span class="rounded bg-sidebar-accent/60 group-hover:bg-sidebar-accent px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums transition-colors">
            {shortcut}
          </span>
        </button>
      </header>

      <Show when={confirmOpen()}>
        <QuitConfirmModal
          onCancel={() => setConfirmOpen(false)}
          onQuit={() => {
            setConfirmOpen(false);
            void electron.window.quit();
          }}
        />
      </Show>

      <Show when={notificationsOpen()}>
        <NotificationsPanel
          anchor={bellRef ?? null}
          align={isMac ? "left" : "right"}
          onClose={() => setNotificationsOpen(false)}
        />
      </Show>
    </>
  );
}

function BellButton(props: {
  ref: (el: HTMLButtonElement) => void;
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  const count = () => unreadCount();
  return (
    <button
      ref={props.ref}
      type="button"
      class="relative flex size-8 items-center justify-center text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors"
      classList={{
        "bg-sidebar-accent/60 text-sidebar-foreground": props.open,
      }}
      style={{ "-webkit-app-region": "no-drag" }}
      aria-label="Notifications"
      aria-expanded={props.open}
      data-tooltip="Notifications"
      data-tooltip-side="bottom"
      onClick={props.onToggle}
    >
      <Bell class="size-3.5" />
      <Show when={count() > 0}>
        <span
          class="absolute top-1 right-1 inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold leading-none text-white tabular-nums"
          aria-label={`${String(count())} unread`}
        >
          {count() > 9 ? "9+" : count()}
        </span>
      </Show>
    </button>
  );
}

// Actionable desktop-update control. Drives the full update gesture directly
// from the titlebar: checks when idle/up-to-date, downloads when an update is
// available, installs when one is downloaded, and retries the failed phase on
// error. Icon + tint encode the state — spinning refresh while checking,
// emerald check when up to date, amber rocket when there's something to act on.
// The sidebar UpdatePill mirrors the same state for users who prefer it there.
function CheckUpdatesButton(): JSX.Element {
  const state = () => updateState();
  const status = () => state()?.status ?? "idle";
  const enabled = () => state()?.enabled ?? false;

  const checking = () => status() === "checking";
  const retryableError = () => status() === "error" && (state()?.canRetry ?? false);
  const actionable = () =>
    status() === "available" ||
    status() === "downloaded" ||
    retryableError();
  const upToDate = () => status() === "up-to-date";

  const tooltip = (): string => {
    const s = state();
    if (!s || !s.enabled) return "Updates disabled (dev build)";
    switch (s.status) {
      case "checking":
        return "Checking for updates…";
      case "up-to-date":
        return s.currentVersion
          ? `Up to date (v${s.currentVersion}) — click to check again`
          : "Up to date — click to check again";
      case "available":
        return s.availableVersion
          ? `Update v${s.availableVersion} available — click to download`
          : "Update available — click to download";
      case "downloading":
        return s.downloadPercent === null
          ? "Downloading update — click for details"
          : `Downloading update (${s.downloadPercent}%) — click for details`;
      case "downloaded":
        return s.downloadedVersion
          ? `Update v${s.downloadedVersion} ready — click to install`
          : "Update ready — click to install";
      case "error":
        return s.message
          ? `Last check failed: ${s.message} — click to retry`
          : "Last check failed — click to retry";
      default:
        return "Check for updates";
    }
  };

  const handleClick = async (): Promise<void> => {
    const s = state();
    if (!s || !s.enabled) return;
    if (s.status === "checking") return;
    try {
      if (s.status === "available") {
        await getElectron().update.download();
      } else if (s.status === "downloaded") {
        await getElectron().update.install();
      } else if (s.status === "error" && s.canRetry) {
        if (s.errorContext === "check") await getElectron().update.check();
        else if (s.errorContext === "download") await getElectron().update.download();
        else if (s.errorContext === "install") await getElectron().update.install();
      } else {
        await getElectron().update.check();
      }
    } catch (err) {
      console.error("[titlebar] update action failed", err);
    }
  };

  return (
    <button
      type="button"
      class="relative flex size-8 items-center justify-center text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors disabled:pointer-events-none"
      classList={{
        "text-emerald-400": upToDate(),
        "text-amber-400": actionable(),
        "text-sky-400": checking(),
        "opacity-50": !enabled(),
      }}
      style={{ "-webkit-app-region": "no-drag" }}
      aria-label={checking() ? "Checking for updates" : actionable() ? "Update available" : "Check for updates"}
      data-tooltip={tooltip()}
      data-tooltip-side="bottom"
      disabled={!enabled() || checking()}
      onClick={() => { void handleClick(); }}
    >
      <Show
        when={actionable()}
        fallback={
          <Show when={upToDate()} fallback={
            <RefreshCw class={checking() ? "size-3.5 animate-spin" : "size-3.5"} />
          }>
            <Check class="size-4" />
          </Show>
        }
      >
        <Rocket class="size-4" />
      </Show>
    </button>
  );
}

function WindowControls(props: { onRequestQuit: () => void }): JSX.Element {
  const electron = getElectron();
  const [maximized, setMaximized] = createSignal(false);

  onMount(() => {
    void electron.window.getMaximized().then(setMaximized);
    const off = electron.window.onMaximizeChange(setMaximized);
    onCleanup(off);
  });

  // Hold-to-quit: pointerdown arms a timer; if it fires while still held the
  // close gesture is converted into a quit-confirm modal. Pointerup before
  // the timer fires clears it and runs the normal hide-to-tray close.
  // Pointerleave/cancel clears the timer without closing — standard button
  // semantics: drag-off cancels.
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let convertedToQuit = false;

  const clearHold = (): void => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  };

  const handleClosePointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    convertedToQuit = false;
    clearHold();
    holdTimer = setTimeout(() => {
      holdTimer = null;
      convertedToQuit = true;
      props.onRequestQuit();
    }, HOLD_TO_QUIT_MS);
  };

  const handleClosePointerUp = (): void => {
    if (convertedToQuit) {
      convertedToQuit = false;
      return;
    }
    clearHold();
    void electron.window.close();
  };

  const handleClosePointerLeave = (): void => {
    clearHold();
    convertedToQuit = false;
  };

  onCleanup(clearHold);

  return (
    <div class="flex h-8 shrink-0" style={{ "-webkit-app-region": "no-drag" }}>
      <button
        type="button"
        class="flex h-8 w-[44px] items-center justify-center text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground transition-colors"
        aria-label="Minimize"
        data-tooltip="Minimize"
        data-tooltip-side="bottom"
        onClick={() => void electron.window.minimize()}
      >
        <Minus class="size-3.5" />
      </button>
      <button
        type="button"
        class="flex h-8 w-[44px] items-center justify-center text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground transition-colors"
        aria-label={maximized() ? "Restore" : "Maximize"}
        data-tooltip={maximized() ? "Restore" : "Maximize"}
        data-tooltip-side="bottom"
        onClick={() => void electron.window.maximizeToggle()}
      >
        {maximized() ? <Copy class="size-3" /> : <Square class="size-3" />}
      </button>
      <button
        type="button"
        class="flex h-8 w-[44px] items-center justify-center text-sidebar-foreground/70 hover:bg-red-600 hover:text-white transition-colors"
        aria-label="Close (hold to quit)"
        data-tooltip="Close · hold to quit"
        data-tooltip-side="bottom"
        onPointerDown={handleClosePointerDown}
        onPointerUp={handleClosePointerUp}
        onPointerLeave={handleClosePointerLeave}
        onPointerCancel={handleClosePointerLeave}
      >
        <X class="size-3.5" />
      </button>
    </div>
  );
}

function NotificationsPanel(props: {
  anchor: HTMLElement | null;
  align: "left" | "right";
  onClose: () => void;
}): JSX.Element {
  let panelRef: HTMLDivElement | undefined;

  // Position the panel under the bell. Recomputed on mount + window resize so
  // it tracks the bell across maximize/restore. We don't reposition on scroll
  // because the titlebar itself doesn't scroll — the bell is fixed-rel to the
  // window edge and the panel can stay attached.
  const [position, setPosition] = createSignal<{ top: number; left: number } | null>(null);
  const PANEL_WIDTH = 360;
  const SIDE_MARGIN = 8;

  const reposition = (): void => {
    if (!props.anchor) return;
    const rect = props.anchor.getBoundingClientRect();
    const top = rect.bottom + 6;
    const left =
      props.align === "right"
        ? Math.max(SIDE_MARGIN, rect.right - PANEL_WIDTH)
        : Math.min(window.innerWidth - PANEL_WIDTH - SIDE_MARGIN, rect.left);
    setPosition({ top, left });
  };

  onMount(() => {
    reposition();
    const onResize = (): void => reposition();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") props.onClose();
    };
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (panelRef?.contains(target)) return;
      if (props.anchor?.contains(target)) return;
      props.onClose();
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("keydown", onKey);
    // capture: true so we close before the click reaches anything that might
    // re-open us in the same gesture.
    document.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
    });
  });

  return (
    <Portal>
      <Show when={position()}>
        {(pos) => (
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Notifications"
            class="fixed z-[250] flex max-h-[480px] w-[360px] flex-col rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl animate-in fade-in-0 zoom-in-95 duration-150"
            style={{
              top: `${String(pos().top)}px`,
              left: `${String(pos().left)}px`,
              "transform-origin": props.align === "right" ? "100% 0%" : "0% 0%",
              "-webkit-app-region": "no-drag",
            }}
          >
            <header class="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
              <h2 class="text-sm font-semibold">Notifications</h2>
              <Show when={notifications().length > 0}>
                <button
                  type="button"
                  class="text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                  onClick={clearAllNotifications}
                >
                  Clear all
                </button>
              </Show>
            </header>
            <div class="flex-1 overflow-y-auto">
              <Show
                when={notifications().length > 0}
                fallback={
                  <div class="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
                    <BellOff class="size-6 text-muted-foreground/40" />
                    <p class="text-sm font-medium text-muted-foreground">No notifications</p>
                    <p class="text-xs text-muted-foreground/60">
                      You're all caught up.
                    </p>
                  </div>
                }
              >
                <ul class="divide-y divide-border/60">
                  <For each={notifications()}>
                    {(n) => <NotificationItem notification={n} />}
                  </For>
                </ul>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </Portal>
  );
}

function NotificationItem(props: { notification: Notification }): JSX.Element {
  const dotClass = (): string => {
    switch (props.notification.kind) {
      case "warning":
        return "bg-amber-500";
      case "error":
        return "bg-red-500";
      default:
        return "bg-sky-400";
    }
  };

  const handleAction = async (): Promise<void> => {
    const action = props.notification.action;
    if (!action) return;
    try {
      const result = await action.onClick();
      if (result === false) return;
      dismissNotification(props.notification.id);
    } catch {
      // Producer can throw to keep the notification visible until they
      // explicitly dismiss it. We don't surface the error here — that's the
      // producer's responsibility (toast, inline error in their flow, etc.).
    }
  };

  const actionToneClass = (): string => {
    const tone = props.notification.action?.tone ?? "primary";
    if (tone === "warning") {
      return "bg-amber-500/20 text-amber-400 hover:bg-amber-500/30";
    }
    return "bg-primary/15 text-primary hover:bg-primary/25";
  };

  return (
    <li class="group flex gap-3 px-4 py-3 hover:bg-accent/40 transition-colors">
      <div class={`mt-1.5 size-2 shrink-0 rounded-full ${dotClass()}`} />
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <div class="flex items-start justify-between gap-2">
          <p class="text-sm font-medium leading-snug">{props.notification.title}</p>
          <button
            type="button"
            class="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
            aria-label="Dismiss"
            onClick={() => dismissNotification(props.notification.id)}
          >
            <X class="size-3.5" />
          </button>
        </div>
        <Show when={props.notification.body}>
          {(body) => (
            <p class="text-xs text-muted-foreground leading-relaxed">{body()}</p>
          )}
        </Show>
        <div class="mt-1 flex items-center gap-2">
          <Show when={props.notification.source}>
            {(source) => (
              <span class="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {source()}
              </span>
            )}
          </Show>
          <Show when={props.notification.action}>
            {(action) => (
              <button
                type="button"
                class={`ml-auto rounded-md px-2.5 py-1 text-[10px] font-bold tracking-wide uppercase transition-colors ${actionToneClass()}`}
                onClick={() => void handleAction()}
              >
                {action().label}
              </button>
            )}
          </Show>
        </div>
      </div>
    </li>
  );
}

function QuitConfirmModal(props: {
  onCancel: () => void;
  onQuit: () => void;
}): JSX.Element {
  return (
    <div
      class="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      style={{ "-webkit-app-region": "no-drag" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="quit-confirm-title"
        class="w-[360px] rounded-lg border border-border bg-popover p-5 shadow-2xl"
      >
        <h2 id="quit-confirm-title" class="text-base font-semibold text-foreground">
          Quit UnCorded?
        </h2>
        <p class="mt-2 text-sm text-muted-foreground">
          This stops every running server container and exits the app. Use the
          tray icon to keep UnCorded running in the background instead.
        </p>
        <div class="mt-5 flex justify-end gap-2">
          <button
            type="button"
            class="rounded-md px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent transition-colors"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 transition-colors"
            onClick={props.onQuit}
          >
            Quit
          </button>
        </div>
      </div>
    </div>
  );
}
