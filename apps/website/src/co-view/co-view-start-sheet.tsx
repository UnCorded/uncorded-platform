// Co-View "Start a session" sheet (spec-27 PR-CV5).
//
// Inline form rendered by <CoViewSheet> when the user clicks "Start". Pre-
// fills from `getCoViewDefaults(accountId)`. On submit, calls
// `startCoView(serverId, ...)`; on ack the parent sheet flips to the
// "Active host controls" view (driven by the parent's hosting state).
//
// Member picker fetches via `coreClient.member.list` (paged, single page is
// enough for typical homelab community sizes; cursor-paged loading is
// out of scope for v1).

import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js";
import type {
  CoViewRenderMode,
  CoViewVisibility,
  CoreMember,
} from "@uncorded/protocol";

import { Avatar } from "@/components/ui/avatar";
import { coreClient } from "@/lib/core-client";
import { account } from "@/stores/auth";

import { startCoView, CoViewError } from "./client";
import {
  ALL_REDACTION_KEYS,
  REDACTION_LABELS,
  getCoViewDefaults,
  isAlwaysRedacted,
  redactionsForWire,
  setCoViewDefaults,
  type CoViewRedactionKey,
} from "./co-view-defaults";

export interface CoViewStartFormProps {
  serverId: string;
  /** Called once `startCoView` resolves with an ack. */
  onStarted: (sessionId: string) => void;
  /** Called when the user clicks Cancel. */
  onCancel: () => void;
}

export function CoViewStartForm(props: CoViewStartFormProps): JSX.Element {
  const accountId = createMemo(() => account()?.id ?? null);
  const initialDefaults = createMemo(() => {
    const id = accountId();
    return id ? getCoViewDefaults(id) : getCoViewDefaults("__anon__");
  });

  const [visibility, setVisibility] = createSignal<CoViewVisibility>(
    initialDefaults().visibility,
  );
  const [renderMode, setRenderMode] = createSignal<CoViewRenderMode>(
    initialDefaults().renderMode,
  );
  const [redactions, setRedactions] = createSignal<CoViewRedactionKey[]>(
    initialDefaults().redactions.slice(),
  );
  const [memberSet, setMemberSet] = createSignal<Set<string>>(new Set());
  const [saveDefaults, setSaveDefaults] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [memberFilter, setMemberFilter] = createSignal("");

  const [members] = createResource(
    () => props.serverId,
    async (serverId): Promise<CoreMember[]> => {
      try {
        const res = await coreClient.member.list(serverId, { limit: 200 });
        return res.members;
      } catch {
        return [];
      }
    },
  );

  const filteredMembers = createMemo(() => {
    const list = members() ?? [];
    const meId = accountId();
    const q = memberFilter().trim().toLowerCase();
    const base = meId ? list.filter((m) => m.id !== meId) : list;
    if (!q) return base;
    return base.filter(
      (m) =>
        m.display_name.toLowerCase().includes(q) ||
        m.username.toLowerCase().includes(q),
    );
  });

  function toggleRedaction(key: CoViewRedactionKey): void {
    if (isAlwaysRedacted(key)) return;
    setRedactions((prev) => {
      const set = new Set(prev);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      const next: CoViewRedactionKey[] = [];
      for (const k of ALL_REDACTION_KEYS) if (set.has(k)) next.push(k);
      return next;
    });
  }

  function toggleMember(userId: string): void {
    setMemberSet((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function handleSubmit(e: Event): Promise<void> {
    e.preventDefault();
    if (submitting()) return;
    setSubmitting(true);
    setError(null);
    const memberIds = Array.from(memberSet());
    const whitelist = visibility() === "private" ? memberIds : [];
    const blacklist = visibility() === "public" ? memberIds : [];
    try {
      const ack = await startCoView(props.serverId, {
        visibility: visibility(),
        whitelist,
        blacklist,
        render_mode: renderMode(),
        redactions: redactionsForWire(redactions()),
      });
      const id = accountId();
      if (id && saveDefaults()) {
        setCoViewDefaults(id, {
          visibility: visibility(),
          renderMode: renderMode(),
          redactions: redactions(),
        });
      }
      props.onStarted(ack.session_id);
    } catch (err) {
      const code = err instanceof CoViewError ? err.code : "unknown";
      const msg = err instanceof Error ? err.message : String(err);
      setError(code === "permission_denied"
        ? "You don't have permission to host Co-View sessions."
        : msg);
    } finally {
      setSubmitting(false);
    }
  }

  const pickerLabel = () =>
    visibility() === "private"
      ? "Whitelist (only these members can see + join)"
      : "Blacklist (these members are blocked from seeing it)";

  return (
    <form onSubmit={(e) => void handleSubmit(e)} class="flex flex-col gap-4">
      <section class="flex flex-col gap-2">
        <h4 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Visibility
        </h4>
        <div class="flex flex-col gap-1.5">
          <RadioRow
            name="visibility"
            value="private"
            checked={visibility() === "private"}
            label="Private — only invited members"
            onSelect={() => setVisibility("private")}
          />
          <RadioRow
            name="visibility"
            value="public"
            checked={visibility() === "public"}
            label="Public — everyone in the server, except blocked"
            onSelect={() => setVisibility("public")}
          />
        </div>
      </section>

      <section class="flex flex-col gap-2">
        <h4 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Render mode
        </h4>
        <div class="flex flex-col gap-1.5">
          <RadioRow
            name="render-mode"
            value="as-viewer"
            checked={renderMode() === "as-viewer"}
            label="As viewer — show what your viewers see (recommended)"
            onSelect={() => setRenderMode("as-viewer")}
          />
          <RadioRow
            name="render-mode"
            value="as-host"
            checked={renderMode() === "as-host"}
            label="As host — show your own view; viewers may see different perms"
            onSelect={() => setRenderMode("as-host")}
          />
        </div>
      </section>

      <section class="flex flex-col gap-2">
        <h4 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Redactions
        </h4>
        <p class="text-xs text-muted-foreground">
          Hidden from viewers. Account settings is always hidden.
        </p>
        <div class="flex flex-col gap-1.5">
          <For each={ALL_REDACTION_KEYS}>
            {(key) => {
              const checked = () => redactions().includes(key);
              const disabled = isAlwaysRedacted(key);
              return (
                <label class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/40">
                  <input
                    type="checkbox"
                    checked={checked()}
                    disabled={disabled}
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

      <section class="flex flex-col gap-2">
        <h4 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {pickerLabel()}
        </h4>
        <input
          type="search"
          placeholder="Filter members..."
          value={memberFilter()}
          onInput={(e) => setMemberFilter(e.currentTarget.value)}
          class="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        />
        <div class="max-h-48 overflow-y-auto rounded-md border border-border">
          <Show
            when={filteredMembers().length > 0}
            fallback={
              <p class="px-3 py-2 text-xs text-muted-foreground">
                {members.loading
                  ? "Loading members..."
                  : "No members match."}
              </p>
            }
          >
            <For each={filteredMembers()}>
              {(m) => {
                const checked = () => memberSet().has(m.id);
                return (
                  <label class="flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-accent/40">
                    <input
                      type="checkbox"
                      checked={checked()}
                      onChange={() => toggleMember(m.id)}
                      class="size-4 rounded border-border accent-primary"
                    />
                    <Avatar
                      userId={m.id}
                      name={m.display_name}
                      src={m.avatar_url}
                      class="size-6"
                    />
                    <span class="text-sm">{m.display_name}</span>
                  </label>
                );
              }}
            </For>
          </Show>
        </div>
      </section>

      <label class="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={saveDefaults()}
          onChange={(e) => setSaveDefaults(e.currentTarget.checked)}
          class="size-4 rounded border-border accent-primary"
        />
        Save these as my defaults on this device
      </label>

      <Show when={error()}>
        <p class="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error()}
        </p>
      </Show>

      <div class="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={() => props.onCancel()}
          class="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent/50"
          disabled={submitting()}
        >
          Cancel
        </button>
        <button
          type="submit"
          class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          disabled={submitting()}
        >
          {submitting() ? "Starting..." : "Start session"}
        </button>
      </div>
    </form>
  );
}

interface RadioRowProps {
  name: string;
  value: string;
  checked: boolean;
  label: string;
  onSelect: () => void;
}

function RadioRow(props: RadioRowProps): JSX.Element {
  return (
    <label class="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/40">
      <input
        type="radio"
        name={props.name}
        value={props.value}
        checked={props.checked}
        onChange={() => props.onSelect()}
        class="mt-1 size-4 accent-primary"
      />
      <span>{props.label}</span>
    </label>
  );
}
