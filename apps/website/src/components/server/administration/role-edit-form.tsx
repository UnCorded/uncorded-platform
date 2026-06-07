// Create / rename / delete a role (spec-22 Amendment B PR 4.4).
//
// The runtime's `RolesEngine` enforces hierarchy on every mutation
// (engine.ts:193 for create, :223 for update, :268 for delete) — these
// forms only filter the obviously-illegal options so the actor doesn't
// run into avoidable error toasts. Default roles never offer
// rename/delete; the runtime would reject those with
// `DEFAULT_ROLE_PROTECTED` anyway.

import {
  createSignal,
  createMemo,
  Show,
  Switch,
  Match,
} from "solid-js";
import { AlertTriangle, Trash2 } from "lucide-solid";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { coreClient, CoreError } from "@/lib/core-client";
import { showInlineStatus } from "@/lib/feedback";
import { refetchRoles } from "@/stores/permissions";
import type { CoreRole } from "@uncorded/protocol";

const NAME_MIN = 1;
const NAME_MAX = 64;
const LEVEL_MIN = 1;
const LEVEL_MAX = 99;

function describeError(err: unknown): string {
  if (err instanceof CoreError) return err.message;
  return "Could not save. Try again.";
}

function isValidName(s: string): boolean {
  const t = s.trim();
  return t.length >= NAME_MIN && t.length <= NAME_MAX;
}

function parseLevelInput(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n)) return null;
  if (n < LEVEL_MIN || n > LEVEL_MAX) return null;
  return n;
}

// ---------------------------------------------------------------------------
// Create role dialog
// ---------------------------------------------------------------------------

export function CreateRoleDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  /** Caller's effective level. Used to clamp the level input to actor < self. */
  actorLevel: number;
  isOwner: boolean;
  onCreated?: (role: CoreRole) => void;
}) {
  const [name, setName] = createSignal("");
  const [levelStr, setLevelStr] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [localError, setLocalError] = createSignal<string | null>(null);

  // Owners can use the full 1..99 range; non-owners are bounded by their own
  // level (engine enforces strict <). We render the bounds in the helper text.
  const maxAllowed = createMemo(() => {
    if (props.isOwner) return LEVEL_MAX;
    return Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, props.actorLevel - 1));
  });

  function reset(): void {
    setName("");
    setLevelStr("");
    setLocalError(null);
  }

  async function handleSubmit(e: Event): Promise<void> {
    e.preventDefault();
    if (!isValidName(name())) {
      setLocalError(`Name must be ${NAME_MIN}-${NAME_MAX} characters.`);
      return;
    }
    const lvl = parseLevelInput(levelStr());
    if (lvl === null) {
      setLocalError(`Level must be an integer between ${LEVEL_MIN} and ${LEVEL_MAX}.`);
      return;
    }
    if (lvl > maxAllowed()) {
      setLocalError(`Level must be ${LEVEL_MIN}-${maxAllowed()} (your level minus 1).`);
      return;
    }

    setSubmitting(true);
    setLocalError(null);
    try {
      const res = await coreClient.role.create(props.serverId, {
        name: name().trim(),
        level: lvl,
      });
      await refetchRoles(props.serverId);
      showInlineStatus(`Created role "${res.role.name}".`, "info");
      props.onCreated?.(res.role);
      props.onOpenChange(false);
      reset();
    } catch (err) {
      setLocalError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(o) => {
        if (!o) reset();
        props.onOpenChange(o);
      }}
    >
      <DialogContent class="max-w-sm p-5">
        <DialogHeader class="gap-1">
          <DialogTitle>Create role</DialogTitle>
          <DialogDescription>
            Roles below your own level only. Names must be unique.
          </DialogDescription>
        </DialogHeader>
        <form class="mt-4 flex flex-col gap-3" onSubmit={(e) => void handleSubmit(e)}>
          <label class="block space-y-1.5">
            <span class="text-xs text-muted-foreground">Name</span>
            <Input
              autofocus
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              maxLength={NAME_MAX}
              placeholder="moderator"
            />
          </label>
          <label class="block space-y-1.5">
            <span class="text-xs text-muted-foreground">
              Level ({LEVEL_MIN}–{maxAllowed()})
            </span>
            <Input
              type="number"
              min={LEVEL_MIN}
              max={maxAllowed()}
              value={levelStr()}
              onInput={(e) => setLevelStr(e.currentTarget.value)}
              placeholder={String(Math.min(60, maxAllowed()))}
            />
          </label>
          <Show when={localError()}>
            <p class="text-xs text-destructive">{localError()}</p>
          </Show>
          <div class="mt-1 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => props.onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting()}>
              {submitting() ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Rename role dialog (custom roles only)
// ---------------------------------------------------------------------------

export function RenameRoleDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  role: CoreRole;
}) {
  const [name, setName] = createSignal(props.role.name);
  const [submitting, setSubmitting] = createSignal(false);
  const [localError, setLocalError] = createSignal<string | null>(null);

  async function handleSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const trimmed = name().trim();
    if (!isValidName(trimmed)) {
      setLocalError(`Name must be ${NAME_MIN}-${NAME_MAX} characters.`);
      return;
    }
    if (trimmed === props.role.name) {
      props.onOpenChange(false);
      return;
    }
    setSubmitting(true);
    setLocalError(null);
    try {
      await coreClient.role.update(props.serverId, props.role.id, { name: trimmed });
      await refetchRoles(props.serverId);
      showInlineStatus(`Renamed to "${trimmed}".`, "info");
      props.onOpenChange(false);
    } catch (err) {
      setLocalError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-sm p-5">
        <DialogHeader class="gap-1">
          <DialogTitle>Rename role</DialogTitle>
          <DialogDescription>
            Renaming "<strong>{props.role.name}</strong>" doesn't change which
            members hold it.
          </DialogDescription>
        </DialogHeader>
        <form class="mt-4 flex flex-col gap-3" onSubmit={(e) => void handleSubmit(e)}>
          <label class="block space-y-1.5">
            <span class="text-xs text-muted-foreground">Name</span>
            <Input
              autofocus
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              maxLength={NAME_MAX}
            />
          </label>
          <Show when={localError()}>
            <p class="text-xs text-destructive">{localError()}</p>
          </Show>
          <div class="mt-1 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => props.onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting()}>
              {submitting() ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Delete role dialog (custom roles only)
// ---------------------------------------------------------------------------

export function DeleteRoleDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  role: CoreRole;
  /** When provided, called after a successful delete (e.g., to clear selection). */
  onDeleted?: () => void;
}) {
  const [submitting, setSubmitting] = createSignal(false);
  const [localError, setLocalError] = createSignal<string | null>(null);

  async function handleConfirm(): Promise<void> {
    setSubmitting(true);
    setLocalError(null);
    try {
      await coreClient.role.delete(props.serverId, props.role.id);
      await refetchRoles(props.serverId);
      showInlineStatus(`Deleted role "${props.role.name}".`, "info");
      props.onDeleted?.();
      props.onOpenChange(false);
    } catch (err) {
      setLocalError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const affected = createMemo(() => props.role.memberCount ?? 0);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-sm p-5">
        <DialogHeader class="gap-2">
          <DialogTitle class="flex items-center gap-2 text-base">
            <AlertTriangle class="size-4 text-destructive" />
            Delete "{props.role.name}"?
          </DialogTitle>
          <DialogDescription>
            <Switch>
              <Match when={affected() === 0}>
                No members currently hold this role. Deletion is reversible
                only by recreating the role and re-granting permissions.
              </Match>
              <Match when={affected() === 1}>
                <strong>1 member</strong> currently holds this role and will
                fall back to the default <code class="rounded bg-muted px-1 py-0.5 text-[0.7rem] font-mono">member</code> role.
              </Match>
              <Match when={affected() > 1}>
                <strong>{affected()} members</strong> currently hold this role
                and will fall back to the default <code class="rounded bg-muted px-1 py-0.5 text-[0.7rem] font-mono">member</code> role.
              </Match>
            </Switch>
          </DialogDescription>
        </DialogHeader>
        <Show when={localError()}>
          <p class="mt-3 text-xs text-destructive">{localError()}</p>
        </Show>
        <div class="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => props.onOpenChange(false)}
            disabled={submitting()}
          >
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void handleConfirm()} disabled={submitting()}>
            <Trash2 class="size-4" />
            {submitting() ? "Deleting…" : "Delete role"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
