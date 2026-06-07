// Audit sub-tab — unified ban + permission audit (spec-22 Amendment B PR 4).
//
// Two backend sources, merged client-side:
//   • core.audit.list           → moderation rows (CoreAuditEntry, ts in `created_at`)
//   • core.permissions.audit    → permission rows (CorePermissionAuditEntry, ts in `ts`)
//
// Sources paginate independently; filter chips toggle which streams are
// visible in the merged view, sorted by ts DESC. "Load more" advances both
// streams (callers can see the most recent activity from either side).

import { createSignal, For, Show, createEffect, onCleanup } from "solid-js";
import { request, onPluginMessage } from "@/lib/ws";
import {
  ensureAuditLoaded,
  loadMoreAudit,
  refetchAudit,
  auditStoreFor,
} from "@/stores/permissions";
import type { CorePermissionAuditEntry } from "@uncorded/protocol";

const PAGE_SIZE = 100;

interface CoreAuditEntry {
  id: string;
  action: string;
  actor_id: string;
  target_id: string | null;
  details: string;
  created_at: number;
}

type Filter = "all" | "bans" | "permissions";

export interface MergedRow {
  ts: number;
  kind: "ban" | "permission";
  // Ban shape:
  banAction?: string;
  banActorId?: string;
  banTargetId?: string | null;
  banReason?: string;
  // Permission shape:
  permAction?: string;
  permActorId?: string;
  permTargetRoleId?: number | null;
  permPermission?: string;
  permReason?: string | null;
  // Stable disambiguator for keyed lists when ts collides.
  uid: string;
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

// RFC 4180 escaping: wrap in quotes if the field contains comma, quote, CR or
// LF; double any embedded quote. Plain values pass through unchanged so the
// output stays diff-friendly when opened in a text editor.
function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function rowsToCsv(rows: readonly MergedRow[]): string {
  const header = [
    "timestamp",
    "kind",
    "action",
    "actor",
    "target",
    "permission",
    "reason",
  ].join(",");
  const lines = [header];
  for (const r of rows) {
    const ts = new Date(r.ts).toISOString();
    const action =
      r.kind === "ban" ? (r.banAction ?? "") : `perm.${r.permAction ?? ""}`;
    const actor =
      r.kind === "ban" ? (r.banActorId ?? "") : (r.permActorId ?? "");
    const target =
      r.kind === "ban"
        ? (r.banTargetId ?? "")
        : r.permTargetRoleId !== null && r.permTargetRoleId !== undefined
          ? `role:${r.permTargetRoleId}`
          : "";
    const permission = r.kind === "permission" ? (r.permPermission ?? "") : "";
    const reason =
      r.kind === "ban" ? (r.banReason ?? "") : (r.permReason ?? "");
    lines.push(
      [ts, r.kind, action, actor, target, permission, reason]
        .map(csvEscape)
        .join(","),
    );
  }
  // Trailing newline matches POSIX text-file convention; some tools (Excel
  // import wizard) skip the last row without it.
  return lines.join("\n") + "\n";
}

export function AuditTab(props: { serverId: string }) {
  const [filter, setFilter] = createSignal<Filter>("all");
  const [bans, setBans] = createSignal<CoreAuditEntry[]>([]);
  const [bansOffset, setBansOffset] = createSignal(0);
  const [bansLoading, setBansLoading] = createSignal(false);
  const [bansHasMore, setBansHasMore] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  // Permissions audit comes from the shared store so a permission grant
  // elsewhere refreshes this view via the existing 200ms-debounced listener.
  const permsState = () => auditStoreFor(props.serverId)();

  async function loadBans(reset: boolean): Promise<void> {
    if (bansLoading()) return;
    setBansLoading(true);
    setError(null);
    try {
      const offset = reset ? 0 : bansOffset();
      const res = await request<CoreAuditEntry[]>(
        props.serverId,
        "core",
        "core.audit.list",
        { limit: PAGE_SIZE, offset },
      );
      setBans((prev) => (reset ? res : [...prev, ...res]));
      setBansOffset(offset + res.length);
      setBansHasMore(res.length === PAGE_SIZE);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit log");
    } finally {
      setBansLoading(false);
    }
  }

  // Initial load — bans surface and permissions store. Permissions has its
  // own ensureLoaded so we don't double-fetch on tab toggles.
  createEffect(() => {
    void loadBans(true);
    void ensureAuditLoaded(props.serverId);
  });

  // Refresh on moderation events. Permissions refresh is handled by the store.
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
        void loadBans(true);
      }
    },
    "administration-audit-panel",
  );
  onCleanup(() => unsub());

  function mergedRows(): MergedRow[] {
    const f = filter();
    const out: MergedRow[] = [];
    if (f !== "permissions") {
      for (const b of bans()) {
        let reason = "";
        try {
          const d = JSON.parse(b.details) as { reason?: string };
          if (d.reason) reason = d.reason;
        } catch {
          /* ignore */
        }
        out.push({
          ts: b.created_at,
          kind: "ban",
          banAction: b.action,
          banActorId: b.actor_id,
          banTargetId: b.target_id,
          banReason: reason,
          uid: `b:${b.id}`,
        });
      }
    }
    if (f !== "bans") {
      for (const p of permsState().entries as CorePermissionAuditEntry[]) {
        out.push({
          ts: p.ts,
          kind: "permission",
          permAction: p.action,
          permActorId: p.actor_user_id,
          permTargetRoleId: p.target_role_id,
          permPermission: p.permission,
          permReason: p.reason,
          uid: `p:${p.id}`,
        });
      }
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
  }

  function exportCsv(): void {
    const rows = mergedRows();
    if (rows.length === 0) return;
    const csv = rowsToCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-${props.serverId}-${filter()}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Defer revoke so the browser has the URL long enough to trigger the
    // download (Firefox is finicky about same-tick revoke).
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function filterChip(label: string, value: Filter) {
    return (
      <button
        class={
          "px-2.5 h-6 text-[11px] rounded-full border transition-colors " +
          (filter() === value
            ? "bg-foreground text-background border-foreground"
            : "border-border text-muted-foreground hover:text-foreground")
        }
        onClick={() => setFilter(value)}
      >
        {label}
      </button>
    );
  }

  return (
    <>
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        {filterChip("All", "all")}
        {filterChip("Bans", "bans")}
        {filterChip("Permissions", "permissions")}
        <button
          class="ml-auto px-2.5 h-6 text-[11px] rounded-full border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          disabled={mergedRows().length === 0}
          onClick={() => exportCsv()}
          data-tooltip="Download the currently visible rows as CSV"
        >
          Export CSV
        </button>
      </div>

      <Show when={error()}>
        <p class="mx-4 mt-3 text-xs text-destructive">{error()}</p>
      </Show>

      <Show
        when={
          mergedRows().length > 0 ||
          bansLoading() ||
          permsState().loading
        }
        fallback={
          <p class="text-center text-sm text-muted-foreground py-8">
            Audit log is empty.
          </p>
        }
      >
        <For each={mergedRows()}>
          {(row) => (
            <div class="px-4 py-2.5 border-b border-border/50">
              <Show when={row.kind === "ban"}>
                <div class="flex items-baseline gap-2 flex-wrap">
                  <span class="text-[10px] font-mono bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                    {row.banAction}
                  </span>
                  <span class="text-[11px] text-muted-foreground">
                    by {row.banActorId}
                    <Show when={row.banTargetId}> · target {row.banTargetId}</Show>
                    {" · "}
                    {relativeTime(row.ts)}
                  </span>
                </div>
                <Show when={row.banReason}>
                  <p class="text-xs text-foreground mt-1 pl-0.5">
                    {row.banReason}
                  </p>
                </Show>
              </Show>
              <Show when={row.kind === "permission"}>
                <div class="flex items-baseline gap-2 flex-wrap">
                  <span class="text-[10px] font-mono bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                    perm.{row.permAction}
                  </span>
                  <span class="text-[11px] text-muted-foreground">
                    by {row.permActorId}
                    <Show when={row.permTargetRoleId !== null}>
                      {" "}· role {row.permTargetRoleId}
                    </Show>
                    {" · "}
                    <code class="font-mono">{row.permPermission}</code>
                    {" · "}
                    {relativeTime(row.ts)}
                  </span>
                </div>
                <Show when={row.permReason}>
                  <p class="text-xs text-foreground mt-1 pl-0.5">
                    {row.permReason}
                  </p>
                </Show>
              </Show>
            </div>
          )}
        </For>
      </Show>

      <Show when={bansHasMore() || permsState().hasMore}>
        <div class="flex justify-center gap-2 py-3 border-b border-border">
          <Show when={filter() !== "permissions" && bansHasMore()}>
            <button
              class="text-[11px] text-muted-foreground border border-border rounded px-2 py-1 hover:text-foreground hover:border-border/60 transition-colors disabled:opacity-50"
              disabled={bansLoading()}
              onClick={() => void loadBans(false)}
            >
              {bansLoading() ? "Loading…" : "Load more bans"}
            </button>
          </Show>
          <Show when={filter() !== "bans" && permsState().hasMore}>
            <button
              class="text-[11px] text-muted-foreground border border-border rounded px-2 py-1 hover:text-foreground hover:border-border/60 transition-colors disabled:opacity-50"
              disabled={permsState().loading}
              onClick={() => void loadMoreAudit(props.serverId)}
            >
              {permsState().loading ? "Loading…" : "Load more permissions"}
            </button>
          </Show>
        </div>
      </Show>

      <Show when={!bansHasMore() && !permsState().hasMore}>
        <button
          class="self-center my-3 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => {
            void loadBans(true);
            void refetchAudit(props.serverId);
          }}
        >
          Refresh
        </button>
      </Show>
    </>
  );
}
