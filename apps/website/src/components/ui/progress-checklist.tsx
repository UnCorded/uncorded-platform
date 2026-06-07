// Shared progress checklist UI. Used by:
//   - the server-creation wizard (long provisioning sequence with named
//     steps that arrive over IPC)
//   - the runtime update panel (3-4 phase sequence: backup → download →
//     install)
//
// Each row shows status icon + label, optionally a sub-line with a one-line
// detail (e.g. "Pulling layer 4/8") and/or a determinate progress bar, and
// — on rows that are actively running — a right-aligned m:ss elapsed-time
// chip that ticks every second so the user can tell the UI is alive even
// when nothing else is changing.

import { For, Show, Switch, Match, type JSX } from "solid-js";
import { Check, AlertTriangle } from "lucide-solid";
import { useNow, formatElapsed } from "@/lib/now-signal";

// Re-export so callers that already import from this surface (e.g. the
// wizard's TunnelStalledCard) don't need to take a second import.
export { formatElapsed };

export type ProgressChecklistStatus =
  | "done"
  | "in_progress"
  | "warning"
  | "skipped"
  | "pending";

export interface ProgressChecklistRow {
  /** Stable key for keying the row. */
  key: string;
  /** Primary label. */
  label: string;
  status: ProgressChecklistStatus;
  /** Optional one-line sub-message under the label. Rendered for
   *  in_progress and warning rows; ignored otherwise (a green check is the
   *  message for done rows). */
  detail?: string | undefined;
  /** 0..1 — when present and the row is in_progress, a determinate bar
   *  renders under the label. */
  percent?: number | null | undefined;
  /** Epoch-ms instant the row first transitioned to in_progress. When
   *  present and the row is in_progress, an m:ss elapsed-time chip
   *  renders on the right side. */
  startedAt?: number | undefined;
}

export function ProgressChecklist(props: {
  rows: () => ProgressChecklistRow[];
  /** Optional all-caps header strip. Pass undefined to render rows with no
   *  surrounding card chrome (caller can wrap as it likes). */
  title?: string | undefined;
}): JSX.Element {
  const body = (
    <ul class="px-3 py-2.5 space-y-1.5">
      <For each={props.rows()}>
        {(row) => <ChecklistRow row={row} />}
      </For>
    </ul>
  );

  return (
    <Show
      when={props.title !== undefined}
      fallback={body}
    >
      <div class="rounded-xl border border-border bg-muted/20">
        <div class="px-3 py-2 border-b border-border text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {props.title}
        </div>
        {body}
      </div>
    </Show>
  );
}

function ChecklistRow(props: { row: ProgressChecklistRow }) {
  const now = useNow();

  const showBar = (): boolean =>
    props.row.status === "in_progress" &&
    typeof props.row.percent === "number";

  const detailText = (): string | undefined => {
    if (props.row.status === "warning") return props.row.detail;
    if (props.row.status === "in_progress") return props.row.detail;
    return undefined;
  };

  const elapsedText = (): string | undefined => {
    if (props.row.status !== "in_progress") return undefined;
    if (props.row.startedAt === undefined) return undefined;
    return formatElapsed(now() - props.row.startedAt);
  };

  return (
    <li>
      <div class="flex items-center gap-2.5">
        <Switch>
          <Match when={props.row.status === "done"}>
            <Check class="size-3.5 shrink-0 text-emerald-500" />
          </Match>
          <Match when={props.row.status === "in_progress"}>
            <div class="size-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" />
          </Match>
          <Match when={props.row.status === "warning"}>
            <AlertTriangle class="size-3.5 shrink-0 text-amber-500" />
          </Match>
          <Match when={props.row.status === "skipped"}>
            <div class="size-3.5 shrink-0 flex items-center justify-center">
              <div class="h-px w-2.5 bg-muted-foreground/40" />
            </div>
          </Match>
          <Match when={props.row.status === "pending"}>
            <div class="size-3.5 shrink-0 flex items-center justify-center">
              <div class="size-1.5 rounded-full bg-muted-foreground/40" />
            </div>
          </Match>
        </Switch>
        <p
          class="text-xs flex-1 min-w-0 truncate"
          classList={{
            "text-foreground": props.row.status === "in_progress" || props.row.status === "done",
            "text-muted-foreground/70": props.row.status === "pending" || props.row.status === "skipped",
            "text-amber-600 dark:text-amber-400": props.row.status === "warning",
          }}
        >
          {props.row.label}
        </p>
        <Show when={elapsedText()}>
          {(text) => (
            <span class="font-mono text-[10px] text-muted-foreground tabular-nums shrink-0">
              {text()}
            </span>
          )}
        </Show>
      </div>
      <Show when={showBar()}>
        <div class="mt-1 ml-6 h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            class="h-full bg-primary transition-[width] duration-150"
            style={{ width: `${String(Math.round((props.row.percent ?? 0) * 100))}%` }}
          />
        </div>
      </Show>
      <Show when={detailText()}>
        {(text) => (
          <p
            class="mt-0.5 ml-6 font-mono text-[10px] truncate"
            classList={{
              "text-amber-600/80 dark:text-amber-400/80": props.row.status === "warning",
              "text-muted-foreground": props.row.status !== "warning",
            }}
          >
            {text()}
          </p>
        )}
      </Show>
    </li>
  );
}
