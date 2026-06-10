// Temp-URL lifecycle UI (WS4). Two surfaces, both driven by the active
// server's `tunnel_state` (set by the runtime heartbeat, persisted by
// Central) — NEVER by string-matching the tunnel hostname:
//
//   • TunnelStateBanner — a dismissible-per-session strip shown while a server
//     is on a demo (quick) Cloudflare tunnel ("demo"). Warns that the URL
//     auto-expires 24h after the server starts and a desktop restart is needed
//     for a fresh address, nudging owners toward a named tunnel for production.
//
//   • TunnelExpiredGate — a blocking state rendered in place of the workspace
//     when the tunnel has expired ("expired"). The runtime has already killed
//     the public URL, so there's nothing to connect to; the only remedy is to
//     restart the UnCorded desktop app (which re-provisions the container and
//     mints a fresh demo tunnel, clearing the state). Composes with WS1: with
//     the workspace unmounted, no plugin iframe attempts to load a dead src.

import { Show, createSignal } from "solid-js";
import { Clock, PlugZap } from "lucide-solid";
import { activeServer } from "@/stores/servers";

// Per-session demo-banner dismissal, keyed by serverId. A module-scope Set
// survives workspace/tab/server switches but resets on a full reload — exactly
// "dismissible per session". The tick signal makes the Set reactive.
const dismissed = new Set<string>();
const [dismissedTick, setDismissedTick] = createSignal(0);

export function TunnelStateBanner() {
  const server = () => activeServer();
  const isDemo = () => server()?.tunnel_state === "demo";
  const isDismissed = () => {
    dismissedTick(); // subscribe
    const s = server();
    return s ? dismissed.has(s.id) : true;
  };

  return (
    <Show when={isDemo() && !isDismissed()}>
      <div class="flex items-center gap-2 border-b border-amber-500/20 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950/60 dark:text-amber-100">
        <Clock class="size-4 shrink-0" />
        <span class="flex-1">
          Temporary URL — this server auto-expires 24 hours after it starts, and
          you'll need to restart the UnCorded desktop app for a new address. Set
          up a named Cloudflare tunnel for production.
        </span>
        <button
          type="button"
          class="ml-auto shrink-0 rounded px-2 py-0.5 text-xs font-medium hover:bg-amber-500/20"
          onClick={() => {
            const s = server();
            if (!s) return;
            dismissed.add(s.id);
            setDismissedTick((n) => n + 1);
          }}
        >
          Dismiss
        </button>
      </div>
    </Show>
  );
}

export function TunnelExpiredGate() {
  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center select-none">
      <div class="flex size-16 items-center justify-center rounded-2xl bg-destructive/10">
        <PlugZap class="size-8 text-destructive" />
      </div>
      <div class="max-w-md">
        <p class="text-sm font-medium text-foreground">
          This server's temporary URL expired
        </p>
        <p class="mt-1 text-xs text-muted-foreground">
          Restart the UnCorded desktop app to get a new address. To avoid this,
          ask the server owner to set up a named Cloudflare tunnel for a stable
          URL.
        </p>
      </div>
    </div>
  );
}
