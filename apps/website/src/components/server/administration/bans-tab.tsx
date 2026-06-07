// Bans sub-tab — extracted from the original ModerationSection (spec-22
// Amendment B PR 4). Behavior is intentionally identical to the pre-rename
// surface; only the imports moved. The plan's DoD requires "Bans sub-tab
// functions identically to before the rename."

import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { Ban } from "lucide-solid";
import { request, onPluginMessage } from "@/lib/ws";

interface CoreBan {
  user_id: string;
  banned_by: string;
  banned_at: number;
  reason: string;
}

function relativeTime(ms: number): string {
  const diffMs = Date.now() - ms;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export function BansTab(props: { serverId: string }) {
  const [banUserId, setBanUserId] = createSignal("");
  const [banReason, setBanReason] = createSignal("");
  const [banTick, setBanTick] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);

  const [bans] = createResource(banTick, () =>
    request<CoreBan[]>(props.serverId, "core", "core.ban.list", {}).catch(
      () => [] as CoreBan[],
    ),
  );

  const unsub = onPluginMessage(
    props.serverId,
    "core",
    (msg) => {
      const ev = msg as { type?: string; topic?: string };
      if (
        ev.type === "event" &&
        (ev.topic === "core.moderation.banned" ||
          ev.topic === "core.moderation.unbanned")
      ) {
        setBanTick((t) => t + 1);
      }
    },
    "administration-bans-panel",
  );
  onCleanup(() => unsub());

  async function handleBan(e: Event) {
    e.preventDefault();
    const uid = banUserId().trim();
    if (!uid) return;
    setError(null);
    try {
      await request(props.serverId, "core", "core.ban.create", {
        user_id: uid,
        reason: banReason().trim(),
      });
      setBanUserId("");
      setBanReason("");
      setBanTick((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to ban user");
    }
  }

  async function handleUnban(userId: string) {
    setError(null);
    try {
      await request(props.serverId, "core", "core.ban.delete", { user_id: userId });
      setBanTick((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unban user");
    }
  }

  return (
    <>
      <Show when={error()}>
        <p class="mx-4 mt-3 text-xs text-destructive">{error()}</p>
      </Show>

      <form
        class="flex flex-col gap-2 p-4 border-b border-border"
        onSubmit={(e) => void handleBan(e)}
      >
        <input
          type="text"
          placeholder="User ID"
          class="h-8 w-full px-3 text-sm bg-muted/50 border border-border rounded-md outline-none focus:border-border/60 placeholder:text-muted-foreground/60"
          value={banUserId()}
          onInput={(e) => setBanUserId(e.currentTarget.value)}
        />
        <div class="flex gap-2">
          <input
            type="text"
            placeholder="Reason (optional)"
            class="h-8 flex-1 px-3 text-sm bg-muted/50 border border-border rounded-md outline-none focus:border-border/60 placeholder:text-muted-foreground/60"
            value={banReason()}
            onInput={(e) => setBanReason(e.currentTarget.value)}
          />
          <button
            type="submit"
            class="h-8 px-3 text-xs font-medium bg-destructive text-white rounded-md hover:opacity-85 transition-opacity shrink-0"
          >
            <Ban class="size-3.5 inline -mt-0.5 mr-1" />
            Ban
          </button>
        </div>
      </form>

      <Show when={bans.loading}>
        <div class="flex justify-center py-8">
          <div class="size-5 animate-spin rounded-full border-2 border-border border-t-foreground/60" />
        </div>
      </Show>
      <Show when={!bans.loading && (bans() ?? []).length === 0}>
        <p class="text-center text-sm text-muted-foreground py-8">No active bans.</p>
      </Show>
      <For each={bans() ?? []}>
        {(ban) => (
          <div class="flex items-start justify-between gap-3 px-4 py-3 border-b border-border/50 last:border-0">
            <div class="min-w-0 flex-1">
              <p class="text-xs font-mono text-muted-foreground truncate">
                {ban.user_id}
              </p>
              <p class="text-[11px] text-muted-foreground/70 mt-0.5">
                by {ban.banned_by} · {relativeTime(ban.banned_at)}
              </p>
              <Show when={ban.reason}>
                <p class="text-xs text-foreground mt-1">{ban.reason}</p>
              </Show>
            </div>
            <button
              class="shrink-0 text-[11px] text-muted-foreground border border-border rounded px-2 py-1 hover:text-foreground hover:border-border/60 transition-colors"
              onClick={() => void handleUnban(ban.user_id)}
            >
              Unban
            </button>
          </div>
        )}
      </For>
    </>
  );
}
