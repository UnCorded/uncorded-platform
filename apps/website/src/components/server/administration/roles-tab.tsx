// Roles sub-tab — role list + selected-role detail with the permission
// matrix (spec-22 Amendment B PR 4.2).
//
// Layout
// ------
//   [ role list      ] [ role detail ]
//   pick a role        header (name, level, "Applies to N members")
//                      permission matrix grouped by plugin slug
//
// On narrow viewports (the sheet is 22rem wide) we stack vertically
// instead — list at the top, detail below — and keep the list compact.
// The settings sheet is always single-column, so practically we always
// render in stack mode here. The dual-pane comment exists so a future
// expansion to a wider drawer doesn't have to retune layout decisions.

import {
  For,
  Show,
  createMemo,
  createSignal,
  createEffect,
} from "solid-js";
import { ChevronRight, MoreVertical, Pencil, Plus, Trash2 } from "lucide-solid";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ensureRolesLoaded,
  ensurePermissionsLoaded,
  rolesStoreFor,
} from "@/stores/permissions";
import { isOwner, currentMember } from "@/stores/membership";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/format-relative";
import {
  CreateRoleDialog,
  DeleteRoleDialog,
  RenameRoleDialog,
} from "./role-edit-form";
import { PermissionMatrix } from "./permission-matrix";
import type { CoreRole } from "@uncorded/protocol";

// "Default" roles ship with the schema and aren't user-editable in name or
// level (the engine refuses with `DEFAULT_ROLE_PROTECTED`). Their permissions
// matrix IS editable though — Amendment B spec acceptance Q2 explicitly
// allows overrides on default roles.

interface RolesTabProps {
  serverId: string;
}

export function RolesTab(props: RolesTabProps) {
  // Both stores are needed: roles drive the list, permissions drive the matrix.
  void ensureRolesLoaded(props.serverId);
  void ensurePermissionsLoaded(props.serverId);

  const rolesState = () => rolesStoreFor(props.serverId)();

  const me = currentMember;
  const ownerActor = isOwner;
  const actorLevel = createMemo(() => {
    if (ownerActor()) return Number.POSITIVE_INFINITY;
    return me()?.level ?? 0;
  });

  const [selectedId, setSelectedId] = createSignal<number | null>(null);
  const [createOpen, setCreateOpen] = createSignal(false);
  const [renameTarget, setRenameTarget] = createSignal<CoreRole | null>(null);
  const [deleteTarget, setDeleteTarget] = createSignal<CoreRole | null>(null);

  // Sorted roles: highest level first, owner pinned at the top regardless.
  // The store already orders by level DESC; we don't re-sort to avoid
  // creating a new array per render.
  const roles = createMemo(() => rolesState().roles);

  // Auto-select the highest non-owner role on first load so the matrix has
  // something to show. Owners can edit the owner role's overrides too —
  // Amendment B does not block that — but the default selection skips it
  // because most edits start with a custom or admin role.
  createEffect(() => {
    if (selectedId() !== null) return;
    const list = roles();
    if (list.length === 0) return;
    const first = list.find((r) => r.level < 100) ?? list[0]!;
    setSelectedId(first.id);
  });

  const selectedRole = createMemo(() => {
    const id = selectedId();
    if (id === null) return null;
    return roles().find((r) => r.id === id) ?? null;
  });

  // A role is editable (rename/delete) when:
  //  - it isn't a default role (engine refuses: DEFAULT_ROLE_PROTECTED)
  //  - the actor is owner, OR has level strictly greater than the role
  function canEditRole(r: CoreRole): boolean {
    if (r.isDefault) return false;
    if (ownerActor()) return true;
    return actorLevel() > r.level;
  }

  // Matrix toggling on a role is gated similarly — engine enforces
  // `assertGrantSafe` + hierarchy on every mutation, but we hide the matrix
  // entirely when the actor cannot mutate, so they don't see a tease.
  function canEditMatrix(r: CoreRole): boolean {
    if (ownerActor()) return true;
    return actorLevel() > r.level;
  }

  return (
    <div class="flex flex-col">
      {/* Role list */}
      <div class="border-b border-border">
        <Show
          when={roles().length > 0}
          fallback={
            <Show
              when={!rolesState().loading}
              fallback={
                <div class="flex justify-center py-8">
                  <div class="size-5 animate-spin rounded-full border-2 border-border border-t-foreground/60" />
                </div>
              }
            >
              <p class="px-4 py-6 text-center text-xs text-muted-foreground">
                No roles yet.
              </p>
            </Show>
          }
        >
          <ul class="divide-y divide-border/40">
            <For each={roles()}>
              {(role) => {
                const active = () => selectedId() === role.id;
                const editable = canEditRole(role);
                return (
                  <li
                    class={cn(
                      "group flex items-center gap-2 px-4 py-2 cursor-pointer transition-colors",
                      active()
                        ? "bg-muted/60"
                        : "hover:bg-muted/30",
                    )}
                    onClick={() => setSelectedId(role.id)}
                  >
                    <ChevronRight
                      class={cn(
                        "size-3 shrink-0 transition-transform",
                        active() ? "rotate-90 text-foreground" : "text-muted-foreground/60",
                      )}
                    />
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm font-medium">{role.name}</p>
                      <p class="text-[10px] text-muted-foreground">
                        level {role.level}
                        {role.isDefault ? " · default" : ""}
                        {" · "}
                        {role.memberCount ?? 0} member
                        {(role.memberCount ?? 0) === 1 ? "" : "s"}
                      </p>
                    </div>
                    <Show when={editable}>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          as="button"
                          class="opacity-0 group-hover:opacity-100 data-[expanded]:opacity-100 flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                          onClick={(e: MouseEvent) => e.stopPropagation()}
                        >
                          <MoreVertical class="size-3.5" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" class="w-36">
                          <DropdownMenuItem
                            onSelect={() => setRenameTarget(role)}
                          >
                            <Pencil class="size-4" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            destructive
                            onSelect={() => setDeleteTarget(role)}
                          >
                            <Trash2 class="size-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>

        <Show when={ownerActor() || actorLevel() > 1}>
          <div class="px-4 py-3 border-t border-border/40">
            <Button
              variant="outline"
              size="sm"
              class="w-full"
              onClick={() => setCreateOpen(true)}
            >
              <Plus class="size-4" />
              Create role
            </Button>
          </div>
        </Show>
      </div>

      {/* Role detail */}
      <Show
        when={selectedRole()}
        fallback={
          <p class="px-4 py-6 text-center text-xs text-muted-foreground">
            Select a role to edit its permissions.
          </p>
        }
      >
        {(r) => (
          <div class="flex flex-col">
            <header class="px-4 py-3 border-b border-border">
              <div class="flex items-baseline gap-2">
                <h3 class="text-sm font-semibold">{r().name}</h3>
                <span class="text-[10px] font-mono bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                  level {r().level}
                </span>
                <Show when={r().isDefault}>
                  <span class="text-[10px] text-muted-foreground">default</span>
                </Show>
              </div>
              <p class="mt-0.5 text-[11px] text-muted-foreground">
                Applies to {r().memberCount ?? 0} member
                {(r().memberCount ?? 0) === 1 ? "" : "s"}
                {" · "}
                Last edited {formatRelative(r().updatedAt)}
              </p>
            </header>

            <Show
              when={canEditMatrix(r())}
              fallback={
                <p class="px-4 py-6 text-center text-xs text-muted-foreground">
                  Your role is at or below "{r().name}". You can't edit its
                  permissions.
                </p>
              }
            >
              <PermissionMatrix serverId={props.serverId} role={r()} />
            </Show>
          </div>
        )}
      </Show>

      {/* Dialogs */}
      <CreateRoleDialog
        open={createOpen()}
        onOpenChange={setCreateOpen}
        serverId={props.serverId}
        actorLevel={actorLevel()}
        isOwner={ownerActor()}
        onCreated={(role) => setSelectedId(role.id)}
      />
      <Show when={renameTarget()}>
        {(t) => (
          <RenameRoleDialog
            open
            onOpenChange={(o) => {
              if (!o) setRenameTarget(null);
            }}
            serverId={props.serverId}
            role={t()}
          />
        )}
      </Show>
      <Show when={deleteTarget()}>
        {(t) => (
          <DeleteRoleDialog
            open
            onOpenChange={(o) => {
              if (!o) setDeleteTarget(null);
            }}
            serverId={props.serverId}
            role={t()}
            onDeleted={() => {
              if (selectedId() === t().id) setSelectedId(null);
            }}
          />
        )}
      </Show>
    </div>
  );
}
