// Per-role permission matrix — the only optimistic-UI surface in spec-22
// Amendment B (lock D4). Tri-state segmented control per permission row,
// grouped by `pluginSlug`.
//
// State model
// -----------
//   Authoritative state (read-only): role.overrides + permission.defaultLevel
//     ↓ rendered as inherit / grant / deny
//   Optimistic overlay: pending<key, "grant"|"deny"|"remove"|"applied">
//     ↓ wins over authoritative until reconciled
//
// The local overlay flips on click (≤16ms per perf budget), then the
// mutation goes out. On success the overlay is cleared and the next
// `core.permission.changed` refetch reconciles. On error the overlay is
// rolled back to the prior authoritative value and the backend message
// surfaces as an inline status. If a `core.permission.changed` arrives
// from a third actor mid-flight (i.e., before our own success returns),
// we drop our overlay in favor of the refetch — matches plan PR 4.3 step 5.
//
// Bulk coalescing
// ---------------
// Rapid clicks in the same role inside a 250ms idle window collect into a
// single `core.permissions.grantMany` request. The window resets on every
// new click, then fires once the user pauses. Single-shot mutations bypass
// the batcher when there's been no activity for >250ms — same UX as a
// trailing-debounced "save" button without the user having to click save.
//
// Danger gating
// -------------
// `core.permissions.manage` is a danger-tier permission:
// granting it requires a confirmation modal. Per-permission flag is
// hardcoded for PR 4 (graduating to a `danger: true` field on Permission
// registration is a Phase 2 follow-up; see plan PR 4.3 "Danger styling").

import {
  createSignal,
  createMemo,
  createEffect,
  For,
  Show,
  onCleanup,
  untrack,
} from "solid-js";
import { Check, Minus, Search, X as XIcon, AlertTriangle } from "lucide-solid";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { coreClient, CoreError } from "@/lib/core-client";
import { showInlineStatus } from "@/lib/feedback";
import { onPluginMessage } from "@/lib/ws";
import {
  ensurePermissionsLoaded,
  permissionsStoreFor,
  refetchRoles,
  rolesStoreFor,
} from "@/stores/permissions";
import { cn } from "@/lib/utils";
import { pendingOpFor, triFromOverride, type TriState } from "./matrix-state";
import {
  collapseQueue,
  filterGroupsByQuery,
  rollbackKeysOf,
  shouldDropOverlay,
  shouldShowMatrixSearch,
  type PendingClick,
} from "./matrix-coordinator";
import type {
  CorePermission,
  CorePermissionChange,
  CoreRole,
} from "@uncorded/protocol";

// Permissions that demand a confirmation modal before a grant. Any future
// `Permission` registration with `danger: true` would join this set.
const DANGER_PERMISSIONS = new Set<string>([
  "core.permissions.manage",
]);

// How long the matrix waits for additional clicks before flushing the
// coalesced batch. 250ms matches plan PR 4.3 "Bulk apply".
const BATCH_IDLE_MS = 250;

interface PermissionMatrixProps {
  serverId: string;
  role: CoreRole;
}

function describeError(err: unknown): string {
  if (err instanceof CoreError) return err.message;
  return "Could not apply change. Try again.";
}

export function PermissionMatrix(props: PermissionMatrixProps) {
  const permsState = () => permissionsStoreFor(props.serverId)();
  const rolesState = () => rolesStoreFor(props.serverId)();

  // Lazy-load the permissions registry. Roles are loaded by the parent.
  void ensurePermissionsLoaded(props.serverId);

  // Authoritative role — re-derived on every roles store update so
  // mid-flight third-party events reconcile cleanly.
  const liveRole = createMemo(() => {
    const id = props.role.id;
    return rolesState().roles.find((r) => r.id === id) ?? props.role;
  });

  // Optimistic overlay — persists until the corresponding mutation settles
  // OR until a `core.permission.changed` arrives from someone else
  // (handled in the WS subscription below).
  const [pending, setPending] = createSignal<Map<string, TriState>>(new Map());
  // Generation guards. The id is incremented on every click so the
  // batched flush can ignore stale entries the user has already overwritten.
  const [generation, setGeneration] = createSignal(0);
  const [inflight, setInflight] = createSignal(false);

  // Confirmation modal target — non-null while the user is being asked to
  // confirm a danger grant.
  const [confirming, setConfirming] = createSignal<{
    permission: CorePermission;
    next: TriState;
  } | null>(null);

  // Coalesce buffer: the click queue that the trailing-edge timer flushes.
  // Stored as a ref so the timer callback closes over the latest array
  // without re-arming the effect.
  let queue: PendingClick[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function effectiveStateFor(key: string): TriState {
    const p = pending();
    if (p.has(key)) return p.get(key)!;
    return triFromOverride(key, liveRole().overrides);
  }

  function setPendingFor(key: string, next: TriState): void {
    setPending((prev) => {
      const m = new Map(prev);
      m.set(key, next);
      return m;
    });
  }

  function clearPendingFor(keys: Iterable<string>): void {
    setPending((prev) => {
      const m = new Map(prev);
      for (const k of keys) m.delete(k);
      return m;
    });
  }

  // Flush the queue as a single grantMany if more than one change, or as
  // a single grant/deny/remove if exactly one. The trailing debouncer
  // collapses the user's clicks into the smallest sufficient request.
  async function flush(): Promise<void> {
    clearTimer();
    if (queue.length === 0) return;
    if (inflight()) {
      // Re-arm so we don't lose the queued work — once the inflight one
      // completes its finally{} runs flush again.
      flushTimer = setTimeout(() => void flush(), BATCH_IDLE_MS);
      return;
    }

    // Collapse the queue: keep only the LAST click per permission key,
    // preserving the user's most recent intent (matrix-coordinator).
    const items = collapseQueue(queue);
    queue = [];

    setInflight(true);
    const keys = items.map((c) => c.permission);
    try {
      if (items.length === 1) {
        const only = items[0]!;
        const op = pendingOpFor(only.next);
        if (op === "grant") {
          await coreClient.permissions.grant(props.serverId, props.role.id, only.permission);
        } else if (op === "deny") {
          await coreClient.permissions.deny(props.serverId, props.role.id, only.permission);
        } else {
          await coreClient.permissions.remove(props.serverId, props.role.id, only.permission);
        }
      } else {
        const changes: CorePermissionChange[] = items.map((c) => ({
          permission: c.permission,
          op: pendingOpFor(c.next),
        }));
        const res = await coreClient.permissions.grantMany(
          props.serverId,
          props.role.id,
          changes,
        );
        if (res.skipped.length > 0) {
          // Roll back the failed ones; the rest reconcile via the refetch.
          const skippedKeys = rollbackKeysOf(res.skipped);
          clearPendingFor(skippedKeys);
          // Surface the first skipped reason — usually they're all the same
          // (HIERARCHY_VIOLATION etc.), so this is signal enough.
          const first = res.skipped[0]!;
          showInlineStatus(`${first.permission}: ${first.message}`, "error");
        }
      }
      // Refetch roles authoritatively. The 200ms event debouncer will also
      // fire from the broadcast — this guarantees we don't show stale
      // local overlay if the user closes the matrix immediately.
      await refetchRoles(props.serverId);
      // Clear any successful overlay entries we still hold. The reconcile
      // step below picks up failures via the ones still in pending.
      clearPendingFor(keys);
    } catch (err) {
      // Whole batch rejected (network, runtime down, FORBIDDEN at
      // grantMany boundary). Roll back the entire collapsed set and tell
      // the user.
      clearPendingFor(keys);
      showInlineStatus(describeError(err), "error");
    } finally {
      setInflight(false);
      // If the user clicked again while we were in flight, the new clicks
      // are sitting in `queue` — re-arm the flush timer to drain them.
      if (queue.length > 0) {
        flushTimer = setTimeout(() => void flush(), BATCH_IDLE_MS);
      }
    }
  }

  function enqueue(perm: CorePermission, next: TriState): void {
    const gen = generation() + 1;
    setGeneration(gen);
    setPendingFor(perm.key, next);
    queue.push({ permission: perm.key, next, generation: gen });
    clearTimer();
    flushTimer = setTimeout(() => void flush(), BATCH_IDLE_MS);
  }

  function attemptFlip(perm: CorePermission, next: TriState): void {
    const current = effectiveStateFor(perm.key);
    if (current === next) return;
    // Only ask for confirmation when *granting* a danger permission.
    // Removing or denying a danger permission is safe and shouldn't gate.
    if (next === "grant" && DANGER_PERMISSIONS.has(perm.key)) {
      setConfirming({ permission: perm, next });
      return;
    }
    enqueue(perm, next);
  }

  function confirmGrant(): void {
    const c = confirming();
    if (!c) return;
    setConfirming(null);
    enqueue(c.permission, c.next);
  }

  // Subscribe to `core.permission.changed`. When events arrive that we did
  // NOT initiate (no inflight + queue empty + no pending matching), we
  // accept the refetched authoritative state by clearing all pending
  // entries — the parent store has already kicked off a debounced refetch.
  const unsub = onPluginMessage(
    props.serverId,
    "core",
    (msg) => {
      const ev = msg as { type?: string; topic?: string };
      if (ev.type !== "event" || ev.topic !== "core.permission.changed") return;
      // If we have nothing in flight and nothing queued, this event must
      // be from another actor. Drop our entire overlay — the next role
      // refetch from stores/permissions.ts will reconcile.
      if (
        shouldDropOverlay({
          inflight: inflight(),
          queueLength: queue.length,
          pendingSize: untrack(pending).size,
        })
      ) {
        setPending(new Map());
      }
    },
    "permission-matrix-watch",
  );
  onCleanup(() => {
    unsub();
    clearTimer();
  });

  // When the role changes (parent selected a different role), reset all
  // local state. We don't carry pending overlays across role changes.
  createEffect(() => {
    void props.role.id;
    setPending(new Map());
    queue = [];
    clearTimer();
  });

  // Group permissions by plugin slug. Stable order: slug ASC, key ASC.
  const grouped = createMemo(() => {
    const groups = new Map<string, CorePermission[]>();
    for (const p of permsState().permissions) {
      const list = groups.get(p.pluginSlug) ?? [];
      list.push(p);
      groups.set(p.pluginSlug, list);
    }
    const out: Array<{ slug: string; perms: CorePermission[] }> = [];
    for (const slug of Array.from(groups.keys()).sort()) {
      const perms = groups.get(slug)!.slice().sort((a, b) => a.key.localeCompare(b.key));
      out.push({ slug, perms });
    }
    return out;
  });

  // Search input — only shown when one plugin group exceeds 25 perms; the
  // matrix is otherwise short enough to scan at a glance. Filters by key
  // and by human description, case-insensitive.
  const [query, setQuery] = createSignal("");
  const showSearch = createMemo(() => shouldShowMatrixSearch(grouped()));
  const visibleGroups = createMemo(() => filterGroupsByQuery(grouped(), query()));

  return (
    <div class="flex flex-col">
      <Show when={showSearch()}>
        <div class="sticky top-0 z-20 border-b border-border/40 bg-background/95 px-4 py-2 backdrop-blur">
          <div class="relative">
            <Search class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search permissions"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              class="w-full rounded-md border border-border bg-background pl-7 pr-2 py-1 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>
      </Show>
      <Show
        when={permsState().permissions.length > 0}
        fallback={
          <Show
            when={!permsState().loading}
            fallback={
              <div class="flex justify-center py-8">
                <div class="size-5 animate-spin rounded-full border-2 border-border border-t-foreground/60" />
              </div>
            }
          >
            <p class="px-4 py-6 text-center text-xs text-muted-foreground">
              No permissions registered yet.
            </p>
          </Show>
        }
      >
        <Show
          when={visibleGroups().length > 0}
          fallback={
            <p class="px-4 py-6 text-center text-xs text-muted-foreground">
              No permissions match "{query()}".
            </p>
          }
        >
        <For each={visibleGroups()}>
          {(group) => (
            <section class="border-b border-border/50 last:border-0">
              <header class="sticky top-0 z-10 bg-background/95 px-4 py-2 text-[10px] font-mono uppercase tracking-wide text-muted-foreground backdrop-blur">
                {group.slug}
              </header>
              <For each={group.perms}>
                {(perm) => {
                  const state = createMemo(() => effectiveStateFor(perm.key));
                  const isPending = createMemo(() => pending().has(perm.key));
                  const isDanger = DANGER_PERMISSIONS.has(perm.key);
                  return (
                    <div
                      class={cn(
                        "flex items-start justify-between gap-3 px-4 py-2.5 border-t border-border/30 first:border-t-0",
                        isPending() && "bg-muted/40",
                      )}
                    >
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-1.5">
                          <code
                            class={cn(
                              "text-[11px] font-mono break-all",
                              isDanger ? "text-destructive" : "text-foreground",
                            )}
                          >
                            {perm.key}
                          </code>
                          <Show when={isDanger}>
                            <AlertTriangle class="size-3 text-destructive shrink-0" />
                          </Show>
                        </div>
                        <p class="mt-0.5 text-[11px] text-muted-foreground line-clamp-2">
                          {perm.description}
                        </p>
                        <p class="mt-0.5 text-[10px] text-muted-foreground/70">
                          default level {perm.defaultLevel}
                        </p>
                      </div>
                      <SegmentedControl
                        value={state()}
                        disabled={false}
                        onChange={(next) => attemptFlip(perm, next)}
                      />
                    </div>
                  );
                }}
              </For>
            </section>
          )}
        </For>
        </Show>
      </Show>

      <Show when={confirming()}>
        {(c) => (
          <Dialog
            open
            onOpenChange={(o) => {
              if (!o) setConfirming(null);
            }}
          >
            <DialogContent class="max-w-sm p-5">
              <DialogHeader class="gap-2">
                <DialogTitle class="flex items-center gap-2 text-base">
                  <AlertTriangle class="size-4 text-destructive" />
                  Grant a danger permission?
                </DialogTitle>
                <DialogDescription>
                  Granting{" "}
                  <code class="rounded bg-muted px-1 py-0.5 text-[0.7rem] font-mono">
                    {c().permission.key}
                  </code>{" "}
                  to <strong>{props.role.name}</strong> lets the role
                  {c().permission.key === "core.permissions.manage"
                    ? " assign and revoke any other permission they hold."
                    : " perform high-impact actions."}{" "}
                  Continue?
                </DialogDescription>
              </DialogHeader>
              <div class="mt-4 flex justify-end gap-2">
                <Button variant="outline" onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmGrant}>
                  Grant
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tri-state segmented control. Three buttons share a row; the active one
// is filled, inactive ones are outlined. Click one to flip; clicking the
// already-active one is a no-op (handled by the parent's effective-state
// equality check before enqueue).
// ---------------------------------------------------------------------------

function SegmentedControl(props: {
  value: TriState;
  disabled: boolean;
  onChange: (next: TriState) => void;
}) {
  const Btn = (b: {
    state: TriState;
    label: string;
    icon: typeof Check;
    activeClass: string;
  }) => (
    <button
      type="button"
      disabled={props.disabled}
      aria-pressed={props.value === b.state}
      onClick={() => props.onChange(b.state)}
      class={cn(
        "inline-flex items-center gap-1 px-2 h-7 text-[11px] font-medium border transition-colors first:rounded-l-md last:rounded-r-md -ml-px first:ml-0 disabled:opacity-50",
        props.value === b.state
          ? b.activeClass
          : "border-border bg-background text-muted-foreground hover:text-foreground",
      )}
    >
      <b.icon class="size-3" />
      {b.label}
    </button>
  );
  return (
    <div class="inline-flex shrink-0">
      <Btn
        state="deny"
        label="Deny"
        icon={XIcon}
        activeClass="bg-destructive text-destructive-foreground border-destructive"
      />
      <Btn
        state="inherit"
        label="Inherit"
        icon={Minus}
        activeClass="bg-muted text-foreground border-border"
      />
      <Btn
        state="grant"
        label="Grant"
        icon={Check}
        activeClass="bg-primary text-primary-foreground border-primary"
      />
    </div>
  );
}
