// Focused sheet for changing a single member's role (spec-22 Amendment B PR 3).
//
// Opened from user-card-sheet's "Manage member" button after the actor's
// `core.permissions.manage` gate has already passed. The runtime is still
// authoritative — every mutation is re-checked, and FORBIDDEN /
// HIERARCHY_VIOLATION surfaces as a toast that reverts local state.
//
// Lock alignment with the plan:
//   - Q1 — self-management UI is hidden; the parent never opens this for self.
//   - D4 — no optimistic UI in PR 3; we refetch after success.
//
// The dropdown is filtered through `assignableRoles()` in stores/permissions.ts
// so the user never sees options the runtime would refuse. The filter is a
// convenience, not a guard — backend rejection still produces a clear toast.

import {
  Show,
  createMemo,
  createResource,
  createSignal,
  For,
} from "solid-js";
import { X, Settings2 } from "lucide-solid";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  closeMemberManage,
  memberManageTarget,
} from "@/stores/member-manage";
import { activeServer, activeServerId } from "@/stores/servers";
import { currentMember } from "@/stores/membership";
import { account } from "@/stores/auth";
import {
  assignableRoles,
  ensureRolesLoaded,
  refetchRoles,
  rolesStoreFor,
} from "@/stores/permissions";
import { coreClient, CoreError } from "@/lib/core-client";
import { showInlineStatus } from "@/lib/feedback";
import type { CoreRole } from "@uncorded/protocol";

const MEMBER_ROLE_NAME_FALLBACK = "member";

function safeAvatarUrl(url: string | null): string | null {
  if (url === null) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

function fallbackInitial(displayName: string): string {
  const trimmed = displayName.trim();
  if (trimmed.length === 0) return "?";
  const iter = trimmed[Symbol.iterator]();
  const first = iter.next().value as string | undefined;
  return (first ?? "?").toUpperCase();
}

export function MemberManageSheet() {
  const open = createMemo(() => memberManageTarget() !== null);
  const target = memberManageTarget;

  // Active server context — every IPC call below depends on it. We don't try
  // to hold a stale id once the active server changes; if it flips while the
  // sheet is open we just close it (the underlying member roster is gone).
  const serverId = createMemo(() => activeServerId());
  const server = activeServer;

  // Trigger the lazy roles store the first time we open. The render path
  // below reads the store reactively; ensureRolesLoaded() is a no-op once
  // it's been fetched at least once for this server.
  createResource(
    () => (open() ? serverId() : null),
    async (id: string | null) => {
      if (!id) return null;
      await ensureRolesLoaded(id);
      return id;
    },
  );

  const rolesState = createMemo(() => {
    const id = serverId();
    if (!id) return { roles: [] as CoreRole[], loading: false, error: null };
    return rolesStoreFor(id)();
  });

  const me = currentMember;

  // Owner and effective level for hierarchy filtering. Owners always pass the
  // engine's strict-greater-than check; non-owners are bounded by `level`.
  const isActorOwner = createMemo(() => {
    const acc = account();
    const srv = server();
    if (!!acc && !!srv && acc.id === srv.owner_id) return true;
    return me()?.is_owner === true;
  });
  const actorLevel = createMemo(() => {
    if (isActorOwner()) return Number.POSITIVE_INFINITY;
    return me()?.level ?? 0;
  });

  // Pre-selection: target's current role. Owner targets are reported as
  // role_id null because the owner role isn't a regular row — but in practice
  // we don't open this sheet for the owner unless the actor is also the owner
  // (gated in user-card-sheet). The dropdown for an owner target is empty.
  const [currentTargetRole, { refetch: refetchTargetRole }] = createResource(
    () => {
      const id = serverId();
      const t = target();
      if (!id || !t) return null;
      return { id, userId: t.userId };
    },
    async (input) => {
      if (!input) return null;
      try {
        const res = await coreClient.member.role(input.id, input.userId);
        return res.role;
      } catch {
        // Non-fatal: dropdown just won't pre-select. Don't toast — the user
        // hasn't acted yet.
        return null;
      }
    },
  );

  // The set of assignable roles for the dropdown. Owner role is always hidden
  // (transferred via Central). Everything `>= actorLevel` is hidden for
  // non-owners.
  const dropdownRoles = createMemo(() =>
    assignableRoles(actorLevel(), isActorOwner(), rolesState().roles),
  );

  // Selected role id — null means "no choice yet". When the resource resolves
  // with the target's current role and the user hasn't touched the dropdown,
  // we pre-select it. We track an explicit "user has chosen" flag so a slow
  // role-fetch can't clobber an early click.
  const [chosenRoleId, setChosenRoleId] = createSignal<number | null>(null);
  const [userTouchedDropdown, setUserTouchedDropdown] = createSignal(false);

  const effectiveRoleId = createMemo(() => {
    if (userTouchedDropdown()) return chosenRoleId();
    const cur = currentTargetRole();
    if (cur && cur.level < 100) return cur.id;
    return null;
  });

  const [submittingAssign, setSubmittingAssign] = createSignal(false);
  const [submittingRemove, setSubmittingRemove] = createSignal(false);

  const isAlreadyMember = createMemo(() => {
    const cur = currentTargetRole();
    return !!cur && cur.name === MEMBER_ROLE_NAME_FALLBACK;
  });

  const canSubmitAssign = createMemo(() => {
    const id = effectiveRoleId();
    if (id === null) return false;
    if (submittingAssign()) return false;
    const cur = currentTargetRole();
    if (cur && cur.id === id) return false;
    return true;
  });

  function handleClose(): void {
    closeMemberManage();
    setChosenRoleId(null);
    setUserTouchedDropdown(false);
  }

  function describeError(err: unknown): string {
    if (err instanceof CoreError) {
      // Backend messages are user-facing for this surface (the runtime author
      // controls them and they're tuned for admins). Codes appear in dev tools
      // but the toast text is the message.
      return err.message;
    }
    return "Could not change role. Try again.";
  }

  async function onAssign(): Promise<void> {
    const id = serverId();
    const t = target();
    const roleId = effectiveRoleId();
    if (!id || !t || roleId === null) return;
    setSubmittingAssign(true);
    try {
      await coreClient.role.assign(id, t.userId, roleId);
      // Refetch authoritative state. The 200ms debounce on
      // `core.permission.changed` will also fire; this just guarantees the
      // sheet shows truth before any close-button race.
      await Promise.all([refetchRoles(id), refetchTargetRole()]);
      setUserTouchedDropdown(false);
      showInlineStatus(`Updated ${t.displayName}'s role.`, "info");
      handleClose();
    } catch (err) {
      showInlineStatus(describeError(err), "error");
    } finally {
      setSubmittingAssign(false);
    }
  }

  async function onRemove(): Promise<void> {
    const id = serverId();
    const t = target();
    if (!id || !t) return;
    setSubmittingRemove(true);
    try {
      await coreClient.role.remove(id, t.userId);
      await Promise.all([refetchRoles(id), refetchTargetRole()]);
      setUserTouchedDropdown(false);
      setChosenRoleId(null);
      showInlineStatus(`${t.displayName} reset to default role.`, "info");
      handleClose();
    } catch (err) {
      showInlineStatus(describeError(err), "error");
    } finally {
      setSubmittingRemove(false);
    }
  }

  return (
    <Sheet open={open()} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <SheetContent
        side="right"
        class="flex w-[22rem] flex-col gap-0 p-0 sm:max-w-[22rem]"
      >
        <SheetHeader class="flex flex-row items-center justify-between gap-0 border-b border-border px-4 py-3">
          <SheetTitle class="text-sm font-semibold">Manage member</SheetTitle>
          <SheetClose class="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
            <X class="size-3.5" />
          </SheetClose>
        </SheetHeader>

        <Show when={target()}>
          {(t) => (
            <div class="flex-1 overflow-y-auto">
              {/* Identity header — same visual language as user-card. */}
              <div class="flex items-center gap-3 border-b border-border px-4 py-4">
                <div class="flex size-12 items-center justify-center overflow-hidden rounded-full bg-muted text-base font-semibold text-muted-foreground ring-1 ring-border">
                  <Show
                    when={safeAvatarUrl(t().avatarUrl) !== null}
                    fallback={<span>{fallbackInitial(t().displayName)}</span>}
                  >
                    <img
                      src={safeAvatarUrl(t().avatarUrl)!}
                      alt={t().displayName}
                      class="size-full object-cover"
                      loading="lazy"
                      decoding="async"
                    />
                  </Show>
                </div>
                <div class="min-w-0">
                  <p class="truncate text-sm font-semibold">{t().displayName}</p>
                  <p class="truncate text-xs text-muted-foreground">
                    Member of {server()?.name ?? "this server"}
                  </p>
                </div>
              </div>

              {/* Section 1 — Server Role */}
              <section class="space-y-3 border-b border-border px-4 py-4">
                <div class="flex items-center gap-2">
                  <Settings2 class="size-4 text-muted-foreground" />
                  <h3 class="text-sm font-semibold">Server role</h3>
                </div>

                <Show
                  when={!rolesState().loading || rolesState().roles.length > 0}
                  fallback={
                    <p class="text-xs text-muted-foreground">Loading roles…</p>
                  }
                >
                  <Show
                    when={dropdownRoles().length > 0}
                    fallback={
                      <p class="text-xs text-muted-foreground">
                        No roles available to assign at your level.
                      </p>
                    }
                  >
                    <label class="block space-y-1.5">
                      <span class="text-xs text-muted-foreground">
                        Select a role
                      </span>
                      <select
                        class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        value={effectiveRoleId() ?? ""}
                        onChange={(e) => {
                          setUserTouchedDropdown(true);
                          const v = e.currentTarget.value;
                          setChosenRoleId(v === "" ? null : Number.parseInt(v, 10));
                        }}
                      >
                        <option value="" disabled>
                          Choose a role…
                        </option>
                        <For each={dropdownRoles()}>
                          {(role) => (
                            <option value={role.id}>
                              {role.name} · level {role.level}
                            </option>
                          )}
                        </For>
                      </select>
                    </label>

                    <Button
                      class="w-full"
                      disabled={!canSubmitAssign()}
                      onClick={onAssign}
                    >
                      {submittingAssign() ? "Changing…" : "Change role"}
                    </Button>
                  </Show>
                </Show>

                <Show when={rolesState().error}>
                  <p class="text-xs text-destructive">
                    Couldn't load roles. Close and try again.
                  </p>
                </Show>
              </section>

              {/* Section 2 — Reset to default */}
              <section class="space-y-3 px-4 py-4">
                <div>
                  <h3 class="text-sm font-semibold">Reset to default</h3>
                  <p class="mt-1 text-xs text-muted-foreground">
                    Removes any explicit role and falls the member back to{" "}
                    <code class="rounded bg-muted px-1 py-0.5 text-[0.7rem]">
                      member
                    </code>
                    .
                  </p>
                </div>
                <Button
                  variant="outline"
                  class="w-full"
                  disabled={
                    submittingRemove() ||
                    isAlreadyMember() ||
                    currentTargetRole.loading
                  }
                  onClick={onRemove}
                >
                  {submittingRemove() ? "Removing…" : "Remove explicit role"}
                </Button>
              </section>
            </div>
          )}
        </Show>
      </SheetContent>
    </Sheet>
  );
}
