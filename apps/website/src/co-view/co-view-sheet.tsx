// Main Co-View sheet (spec-27 PR-CV5).
//
// Single canonical surface, opened from the sidebar. Three views, picked by
// the local hosting/active state:
//
//   1. Default — shows the active-sessions roster + a "Start a session" button.
//   2. Starting — embedded <CoViewStartForm>; on success, hands the new
//      session_id up to App.tsx via `onHostStarted` so the host runner mounts.
//   3. Hosting — pause/resume + end + viewer roster + redaction toggles.
//
// The sheet doesn't own producer/consumer lifecycle — it is a pure UI shell.
// HostShellRunner / ViewerSession (mounted by App.tsx) own the wire activity.

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  type JSX,
} from "solid-js";
import { X } from "lucide-solid";
import type { CoViewSessionSummary } from "@uncorded/protocol";

import { Avatar } from "@/components/ui/avatar";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useHasPermission } from "@/hooks/use-has-permission";
import { account } from "@/stores/auth";

import { createActiveSessionsStore, type ActiveSessionsStore } from "./active-sessions-store";
import {
  endCoView,
  joinCoView,
  leaveCoView,
  updateCoView,
  CoViewError,
} from "./client";
import { CoViewStartForm } from "./co-view-start-sheet";
import {
  ALL_REDACTION_KEYS,
  REDACTION_LABELS,
  isAlwaysRedacted,
  redactionsForWire,
  type CoViewRedactionKey,
} from "./co-view-defaults";

export interface CoViewSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  /** Session id when the local user is currently hosting on this connection. */
  hostingSessionId: string | null;
  /** Pause flag for the local host session — so the sheet's button matches reality. */
  hostingPaused: boolean;
  /** Session id when the local user is currently viewing a session in this server. */
  viewingSessionId: string | null;
  /** Called after `startCoView` resolves so App.tsx can mount HostShellRunner. */
  onHostStarted: (sessionId: string) => void;
  /** Called after `joinCoView` resolves so App.tsx can mount ViewerSession with the snapshot. */
  onJoined: (
    sessionId: string,
    snapshot: import("@uncorded/protocol").CoViewStateSnapshot | null,
  ) => void;
  /** Called when the host clicks End or the local viewer clicks Leave. */
  onHostEnded: () => void;
  onViewerLeft: () => void;
  /** Called by App.tsx when the host's pause toggle should flip. */
  onHostPauseChange: (paused: boolean) => void;
}

type View = "default" | "starting" | "hosting";

export function CoViewSheet(props: CoViewSheetProps): JSX.Element {
  const [view, setView] = createSignal<View>("default");
  const canHost = useHasPermission("co-view.host");
  const canModerate = useHasPermission("co-view.moderate");

  // Roster store, scoped to the sheet's lifetime: only subscribe when open
  // so closed-sheet servers don't keep a list.req subscription alive.
  const [store, setStore] = createSignal<ActiveSessionsStore | null>(null);
  createEffect(
    on(
      () => [props.open, props.serverId] as const,
      ([open, serverId]) => {
        const prev = store();
        if (prev) prev.dispose();
        setStore(open ? createActiveSessionsStore(serverId) : null);
      },
    ),
  );
  onCleanup(() => store()?.dispose());

  // Auto-flip into "hosting" view when App.tsx tells us we're hosting.
  createEffect(
    on(
      () => props.hostingSessionId,
      (id) => {
        if (id) setView("hosting");
        else if (view() === "hosting") setView("default");
      },
    ),
  );

  const sessions = createMemo(() => store()?.sessions() ?? []);
  const ready = createMemo(() => store()?.ready() ?? false);

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent
        side="right"
        class="flex w-full flex-col gap-0 p-0 sm:max-w-md"
      >
        <SheetHeader class="flex flex-row items-center justify-between gap-0 border-b border-border px-4 py-3">
          <SheetTitle class="text-sm font-semibold">Co-View</SheetTitle>
          <SheetClose class="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
            <X class="size-3.5" />
          </SheetClose>
        </SheetHeader>

        <div class="flex-1 overflow-y-auto">
          <Show when={view() === "starting"}>
            <div class="px-4 py-4">
              <CoViewStartForm
                serverId={props.serverId}
                onStarted={(id) => {
                  props.onHostStarted(id);
                  setView("hosting");
                }}
                onCancel={() => setView("default")}
              />
            </div>
          </Show>

          <Show when={view() === "hosting" && props.hostingSessionId}>
            <ActiveHostControls
              serverId={props.serverId}
              sessionId={props.hostingSessionId!}
              paused={props.hostingPaused}
              session={sessions().find((s) => s.session_id === props.hostingSessionId) ?? null}
              canModerate={canModerate()}
              onEnd={() => {
                props.onHostEnded();
                setView("default");
              }}
              onPauseChange={(p) => props.onHostPauseChange(p)}
            />
          </Show>

          <Show when={view() === "default"}>
            <ActiveSessionsList
              sessions={sessions()}
              ready={ready()}
              meSessionId={props.viewingSessionId}
              onJoin={async (sessionId) => {
                try {
                  const ack = await joinCoView(props.serverId, sessionId);
                  props.onJoined(sessionId, ack.current_state_snapshot ?? null);
                  props.onOpenChange(false);
                } catch (err) {
                  console.warn("[co-view] join failed", err);
                }
              }}
              onLeaveActive={async () => {
                if (!props.viewingSessionId) return;
                try {
                  await leaveCoView(props.serverId, props.viewingSessionId);
                } catch (err) {
                  console.warn("[co-view] leave failed", err);
                } finally {
                  props.onViewerLeft();
                }
              }}
            />

            <div class="border-t border-border px-4 py-4">
              <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Host a session
              </h3>
              <Show
                when={canHost()}
                fallback={
                  <p class="text-xs text-muted-foreground">
                    You don't have the <code>co-view.host</code> permission on this server.
                  </p>
                }
              >
                <button
                  type="button"
                  onClick={() => setView("starting")}
                  disabled={props.hostingSessionId !== null}
                  class="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                  title={
                    props.hostingSessionId
                      ? "You're already hosting on this connection."
                      : ""
                  }
                >
                  {props.hostingSessionId ? "You're already hosting" : "Start a session"}
                </button>
              </Show>
            </div>
          </Show>
        </div>
      </SheetContent>
    </Sheet>
  );
}

interface ActiveSessionsListProps {
  sessions: CoViewSessionSummary[];
  ready: boolean;
  meSessionId: string | null;
  onJoin: (sessionId: string) => void;
  onLeaveActive: () => void;
}

function ActiveSessionsList(props: ActiveSessionsListProps): JSX.Element {
  return (
    <div class="px-4 py-4">
      <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Active sessions
      </h3>
      <Show
        when={props.ready}
        fallback={
          <div class="rounded-md border border-border bg-card/40 px-3 py-4 text-center text-xs text-muted-foreground">
            Loading...
          </div>
        }
      >
        <Show
          when={props.sessions.length > 0}
          fallback={
            <div class="rounded-md border border-border bg-card/40 px-3 py-4 text-center text-xs text-muted-foreground">
              No one is hosting yet.
            </div>
          }
        >
          <ul class="flex flex-col gap-2">
            <For each={props.sessions}>
              {(s) => {
                const isMine = () => s.session_id === props.meSessionId;
                return (
                  <li class="flex items-center gap-3 rounded-md border border-border px-3 py-2.5">
                    <Avatar
                      userId={s.host_user_id}
                      name={s.host_display_name}
                      src={null}
                      class="size-8"
                    />
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm font-medium">
                        {s.host_display_name}
                      </p>
                      <p class="text-xs text-muted-foreground">
                        {s.visibility === "public" ? "Public" : "Private"} ·{" "}
                        {s.viewer_count} {s.viewer_count === 1 ? "viewer" : "viewers"}
                        {s.paused ? " · Paused" : ""}
                      </p>
                    </div>
                    <Show
                      when={isMine()}
                      fallback={
                        <button
                          type="button"
                          onClick={() => props.onJoin(s.session_id)}
                          class="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent/50"
                        >
                          Join
                        </button>
                      }
                    >
                      <button
                        type="button"
                        onClick={() => props.onLeaveActive()}
                        class="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent/50"
                      >
                        Leave
                      </button>
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  );
}

interface ActiveHostControlsProps {
  serverId: string;
  sessionId: string;
  paused: boolean;
  session: CoViewSessionSummary | null;
  canModerate: boolean;
  onEnd: () => void;
  onPauseChange: (paused: boolean) => void;
}

function ActiveHostControls(props: ActiveHostControlsProps): JSX.Element {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Editable redactions: derived from the session summary if we have one, but
  // since CoViewSessionSummary doesn't carry redactions today the host edits
  // them blind locally and we PATCH on toggle. (Future: surface server state.)
  const [localRedactions, setLocalRedactions] = createSignal<CoViewRedactionKey[]>(
    ["account-settings"],
  );

  async function patch(
    p: Parameters<typeof updateCoView>[2],
    label: string,
  ): Promise<void> {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await updateCoView(props.serverId, props.sessionId, p);
    } catch (err) {
      const msg = err instanceof CoViewError ? err.message : String(err);
      setError(`${label} failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  async function togglePause(): Promise<void> {
    const next = !props.paused;
    props.onPauseChange(next);
    await patch({ paused: next }, next ? "Pause" : "Resume");
  }

  async function handleEnd(): Promise<void> {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await endCoView(props.serverId, props.sessionId);
      props.onEnd();
    } catch (err) {
      const msg = err instanceof CoViewError ? err.message : String(err);
      setError(`End failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  function toggleRedaction(key: CoViewRedactionKey): void {
    if (isAlwaysRedacted(key)) return;
    const set = new Set(localRedactions());
    if (set.has(key)) set.delete(key);
    else set.add(key);
    const next: CoViewRedactionKey[] = [];
    for (const k of ALL_REDACTION_KEYS) if (set.has(k)) next.push(k);
    setLocalRedactions(next);
    void patch({ redactions: redactionsForWire(next) }, "Redaction update");
  }

  const viewerCount = () => props.session?.viewer_count ?? 0;

  return (
    <div class="flex flex-col gap-4 px-4 py-4">
      <section class="flex flex-col gap-2">
        <p class="text-sm font-medium">
          You're hosting · {viewerCount()} {viewerCount() === 1 ? "viewer" : "viewers"}
          {props.paused ? " · Paused" : ""}
        </p>
        <Show when={props.canModerate}>
          <p class="text-xs text-muted-foreground">
            Moderation tools available.
          </p>
        </Show>
      </section>

      <section class="flex gap-2">
        <button
          type="button"
          onClick={() => void togglePause()}
          disabled={busy()}
          class="flex-1 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent/50 disabled:opacity-60"
        >
          {props.paused ? "Resume" : "Pause"}
        </button>
        <button
          type="button"
          onClick={() => void handleEnd()}
          disabled={busy()}
          class="flex-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/20 disabled:opacity-60"
        >
          End session
        </button>
      </section>

      <section class="flex flex-col gap-2">
        <h4 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Redactions
        </h4>
        <p class="text-xs text-muted-foreground">
          Toggling pushes a live update to all viewers.
        </p>
        <div class="flex flex-col gap-1.5">
          <For each={ALL_REDACTION_KEYS}>
            {(key) => {
              const checked = () => localRedactions().includes(key);
              const disabled = isAlwaysRedacted(key);
              return (
                <label class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/40">
                  <input
                    type="checkbox"
                    checked={checked()}
                    disabled={disabled || busy()}
                    onChange={() => toggleRedaction(key)}
                    class="size-4 rounded border-border accent-primary disabled:opacity-60"
                  />
                  <span class={disabled ? "text-muted-foreground" : ""}>
                    {REDACTION_LABELS[key]}
                  </span>
                </label>
              );
            }}
          </For>
        </div>
      </section>

      <Show when={error()}>
        <p class="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error()}
        </p>
      </Show>

      <Show when={!account()}>
        <p class="text-xs text-muted-foreground">
          You appear signed out — host actions may fail.
        </p>
      </Show>
    </div>
  );
}
