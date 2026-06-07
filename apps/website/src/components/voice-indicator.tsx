// VoiceIndicator — sidebar-footer surface above NavUser. Renders the shell
// voice manager's reactive state directly (sibling consumer to plugin
// iframes; not a mirror of plugin pushes — see contract §15).
//
// State source: `state()`, `participants()`, `activeSpeakerIds()` exported by
// `@/lib/voice-manager`. These signals live inside the manager's module-level
// `createRoot` and are safe to read from any component owner — the createRoot
// guarantees they're never disposed during the page's lifetime, so component
// remounts don't fork a parallel state source (review pin #1).
//
// Actions (Mute / Leave / Retry / Dismiss): per contract §15, the indicator
// calls the manager's exported methods directly, NOT via `dispatch()` /
// postMessage round-trip. The indicator is shell-side, not a sandboxed iframe;
// envelope construction would add latency without adding isolation.

import { Show, createMemo, createSignal, createEffect, onCleanup } from "solid-js";
import {
  Mic,
  MicOff,
  PhoneOff,
  AlertCircle,
  X,
  RefreshCw,
  Lock,
  Headphones,
  HeadphoneOff,
} from "lucide-solid";
import * as voiceManager from "@/lib/voice-manager";
import { SidebarMenu, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";

// ~5s auto-dismiss for the failed-state inline error row (§15 table row).
const FAILED_AUTODISMISS_MS = 5_000;

export function VoiceIndicator() {
  const { state: sidebarState } = useSidebar();
  const collapsed = () => sidebarState() === "collapsed";

  // Local UI state: dismissed-failed gate. The manager's `state.status` may
  // remain "failed" until a retry, but the inline-error row should auto-hide
  // after ~5s (§15) and stay hidden if the user clicks Dismiss. A new
  // failure (different error.message) re-shows it.
  const [dismissedFailedKey, setDismissedFailedKey] = createSignal<string | null>(null);

  const failedKey = createMemo(() => {
    const s = voiceManager.state();
    if (s.status !== "failed") return null;
    return `${s.error?.code ?? "unknown"}:${s.error?.message ?? ""}`;
  });

  // Auto-dismiss timer per failed-key. createEffect re-runs when failedKey
  // changes, so a new failure resets the dismiss state and starts a fresh
  // timer; navigating away from failed (status changes) clears the timer
  // implicitly through the early-return.
  createEffect(() => {
    const key = failedKey();
    if (key === null) return;
    if (dismissedFailedKey() === key) return;
    const timer = setTimeout(() => {
      // Only auto-dismiss if we're still on the same key — a fresh failure
      // would have changed the key and cancelled this branch via re-run.
      if (failedKey() === key) setDismissedFailedKey(key);
    }, FAILED_AUTODISMISS_MS);
    // Solid cleanup: timer is cleared if this effect re-runs (key changed)
    // or the component unmounts.
    return () => clearTimeout(timer);
  });

  // Clear the dismiss memory whenever we leave the failed state. Without
  // this, Retry on a same-cause failure (e.g. revoked capability still
  // missing) goes status: failed → connecting → failed with the SAME
  // error.code+message → failedKey unchanged → still equals
  // dismissedFailedKey → row stays hidden. User clicks Retry, sees nothing.
  // The brief "connecting" hop on retry resets the dismiss memory through
  // this effect so the second failure re-shows the row with a fresh 5s
  // timer.
  createEffect(() => {
    if (voiceManager.state().status !== "failed") {
      setDismissedFailedKey(null);
    }
  });

  const showFailedRow = createMemo(() => {
    const key = failedKey();
    return key !== null && dismissedFailedKey() !== key;
  });

  // Visible at all? §15 row 1: idle / disconnected → not rendered.
  // Failed → rendered only while showFailedRow is true (auto-dismiss honors
  // the §15 "~5s" timer).
  const visible = createMemo(() => {
    const s = voiceManager.state();
    if (s.status === "idle" || s.status === "disconnected") return false;
    if (s.status === "failed") return showFailedRow();
    return true;
  });

  // Local user identity for active-speaker ring detection. The manager's
  // participants list flags isLocal; we resolve once per render.
  const localSpeaking = createMemo(() => {
    const local = voiceManager.participants().find((p) => p.isLocal);
    if (!local) return false;
    return voiceManager.activeSpeakerIds().includes(local.userId);
  });

  // Channel label fallback — plugin should pass channelName via the connect
  // envelope (5b). Until then, slug the channelId so the indicator still
  // renders something sensible during 5a smoke tests.
  const channelLabel = () => {
    const s = voiceManager.state();
    if (s.channelName) return s.channelName;
    if (s.channelId) return s.channelId.slice(0, 8);
    return "";
  };

  return (
    <Show when={visible()}>
      <SidebarMenu>
        <SidebarMenuItem>
          <Show
            when={voiceManager.state().status === "failed"}
            fallback={
              <Show when={collapsed()} fallback={<ExpandedRow speaking={localSpeaking()} />}>
                <CollapsedRow speaking={localSpeaking()} />
              </Show>
            }
          >
            <FailedRow
              channelLabel={channelLabel()}
              onDismiss={() => {
                const k = failedKey();
                if (k !== null) setDismissedFailedKey(k);
              }}
            />
          </Show>
        </SidebarMenuItem>
      </SidebarMenu>
    </Show>
  );
}

// ---------------------------------------------------------------------------
// Expanded variant — full label + actions.
// ---------------------------------------------------------------------------

function ExpandedRow(props: { speaking: boolean }) {
  const s = voiceManager.state;
  const status = () => s().status;
  const mic = () => s().mic;

  const dotClass = () => {
    if (status() === "connecting") return "bg-primary animate-pulse";
    if (status() === "reconnecting") return "bg-amber-500 animate-pulse";
    return "bg-primary";
  };

  const channelText = () =>
    s().channelName ?? s().channelId?.slice(0, 8) ?? "";

  // Tick once a second to refresh the elapsed-time readout while the row is
  // mounted. The interval is owned by the component lifecycle (onCleanup on
  // unmount), so it stops as soon as the indicator is hidden — no leak on
  // disconnect / route change. We don't need millisecond accuracy; rendering
  // every second is plenty for an mm:ss display.
  const [now, setNow] = createSignal(Date.now());
  const interval = window.setInterval(() => setNow(Date.now()), 1_000);
  onCleanup(() => window.clearInterval(interval));

  const elapsed = createMemo<string | null>(() => {
    const startedAt = voiceManager.connectedAt();
    if (startedAt === null) return null;
    const totalSeconds = Math.max(0, Math.floor((now() - startedAt) / 1_000));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const ss = totalSeconds % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    if (h > 0) return `${String(h)}:${pad(m)}:${pad(ss)}`;
    return `${pad(m)}:${pad(ss)}`;
  });

  const statusLine = () => {
    if (status() === "connecting") return "Connecting…";
    if (status() === "reconnecting") return "Reconnecting…";
    if (mic().serverMuted) return "Server-muted";
    if (!mic().available) return "Mic unavailable";
    return "Voice connected";
  };

  const deafened = () => s().deafened === true;

  // Compact two-row layout: tiny status + channel name on top, three icon
  // buttons (mic / deafen / leave) on the bottom. Active-speaker ring lives
  // on the wrapper so it's a CSS class flip, not a re-render (§15 pin:
  // "decorative-only: do not re-render").
  return (
    <div
      class="flex flex-col gap-1 rounded-md px-2 py-1.5"
      classList={{
        "ring-2 ring-primary/60 ring-offset-1 ring-offset-sidebar": props.speaking,
      }}
    >
      <div class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span class={`inline-block size-1.5 shrink-0 rounded-full ${dotClass()}`} />
        <span class="truncate">{statusLine()}</span>
        <Show when={elapsed() !== null}>
          <span
            class="shrink-0 font-mono tabular-nums text-muted-foreground/80"
            aria-label="Session duration"
          >
            {elapsed()}
          </span>
        </Show>
        <span class="ml-auto truncate font-medium text-foreground">
          #{channelText()}
        </span>
      </div>
      <div class="flex items-center justify-between gap-1">
        {/* Mute — disabled during reconnecting/connecting and when server-muted. */}
        <Show
          when={
            status() === "connected" &&
            mic().available &&
            !mic().serverMuted
          }
          fallback={
            <Show when={status() === "connected" && mic().serverMuted}>
              <span
                class="flex h-7 flex-1 items-center justify-center rounded text-muted-foreground/60"
                aria-label="Mic locked by server"
                title="Mic locked by server"
              >
                <Lock class="size-4" />
              </span>
            </Show>
          }
        >
          <button
            type="button"
            class="flex h-7 flex-1 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            classList={{
              "text-destructive hover:text-destructive": mic().muted,
            }}
            aria-label={mic().muted ? "Unmute" : "Mute"}
            title={mic().muted ? "Unmute" : "Mute"}
            onClick={() => voiceManager.setMicMuted(!mic().muted)}
          >
            <Show when={mic().muted} fallback={<Mic class="size-4" />}>
              <MicOff class="size-4" />
            </Show>
          </button>
        </Show>
        {/* Deafen — only meaningful while connected. Hidden during connect/reconnect. */}
        <Show when={status() === "connected"}>
          <button
            type="button"
            class="flex h-7 flex-1 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            classList={{
              "text-destructive hover:text-destructive": deafened(),
            }}
            aria-label={deafened() ? "Undeafen" : "Deafen"}
            title={deafened() ? "Undeafen" : "Deafen"}
            onClick={() => voiceManager.setDeafened(!deafened())}
          >
            <Show when={deafened()} fallback={<Headphones class="size-4" />}>
              <HeadphoneOff class="size-4" />
            </Show>
          </button>
        </Show>
        {/* Leave — always available except during initial connecting. */}
        <Show when={status() !== "connecting"}>
          <button
            type="button"
            class="flex h-7 flex-1 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label="Leave voice"
            title="Leave voice"
            onClick={() => void voiceManager.disconnect()}
          >
            <PhoneOff class="size-4" />
          </button>
        </Show>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collapsed variant — dot + state-icon overlay only (§15 "Width" bullet).
// ---------------------------------------------------------------------------

function CollapsedRow(props: { speaking: boolean }) {
  const s = voiceManager.state;
  const status = () => s().status;
  const mic = () => s().mic;

  const dotClass = () => {
    if (status() === "connecting") return "bg-primary animate-pulse";
    if (status() === "reconnecting") return "bg-amber-500 animate-pulse";
    return "bg-primary";
  };

  const overlay = () => {
    if (status() !== "connected") return null;
    // Deafen takes precedence — it implies the mic is muted too, but the
    // headphone-off icon is the more informative state to show in 12px.
    if (s().deafened === true) return <HeadphoneOff class="size-3" />;
    if (mic().serverMuted) return <Lock class="size-3" />;
    if (!mic().available) return <MicOff class="size-3" />;
    if (mic().muted) return <MicOff class="size-3" />;
    return null;
  };

  return (
    <div
      class="flex items-center justify-center px-2 py-2"
      title={
        status() === "connected" && mic().muted
          ? "Muted"
          : status() === "connected"
            ? "In voice"
            : status()
      }
    >
      <div
        class="relative flex size-6 items-center justify-center rounded-full"
        classList={{
          "ring-2 ring-primary/60 ring-offset-1 ring-offset-sidebar": props.speaking,
        }}
      >
        <span class={`size-2 rounded-full ${dotClass()}`} />
        <Show when={overlay() !== null}>
          <span class="absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-sidebar text-muted-foreground">
            {overlay()}
          </span>
        </Show>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Failed variant — auto-dismissing error row with Retry / Dismiss.
// ---------------------------------------------------------------------------

function FailedRow(props: { channelLabel: string; onDismiss: () => void }) {
  const message = () => voiceManager.state().error?.message ?? "Voice failed.";
  // Truncate to keep the row at one line; the title attribute carries the
  // full message for hover.
  const truncated = () => {
    const m = message();
    return m.length > 60 ? m.slice(0, 57) + "…" : m;
  };

  return (
    <div
      class="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-2 text-sm text-destructive"
      title={message()}
    >
      <AlertCircle class="size-4 shrink-0" />
      <span class="flex-1 truncate text-left text-xs">
        Voice failed · {truncated()}
      </span>
      <button
        type="button"
        class="rounded p-1 hover:bg-destructive/10"
        aria-label="Retry"
        onClick={() => voiceManager.retry()}
      >
        <RefreshCw class="size-4" />
      </button>
      <button
        type="button"
        class="rounded p-1 hover:bg-destructive/10"
        aria-label="Dismiss"
        onClick={() => props.onDismiss()}
      >
        <X class="size-4" />
      </button>
    </div>
  );
}
