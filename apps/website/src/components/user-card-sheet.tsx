import { Show, createMemo } from "solid-js";
import { Settings2, X } from "lucide-solid";
import { getClientColor, getNameInitial } from "@uncorded/shared";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { closeUserCard, userCard } from "@/stores/user-card";
import { openMemberManage } from "@/stores/member-manage";
import { account } from "@/stores/auth";
import { activeServer } from "@/stores/servers";
import { isOwner } from "@/stores/membership";
import { useHasPermission } from "@/hooks/use-has-permission";

// Discord-style rich card opened when a user avatar is clicked anywhere in
// the shell or in a plugin iframe. Same primitive serves message-author
// avatars in text-channels, participant avatars in voice-channels, and the
// sidebar voice-presence stack — all routed through the user-card store.
//
// The card content stays intentionally lean for Phase 1: hero avatar, display
// name, deterministic initial fallback, and a closeable sheet container. CTAs
// (Send DM, View Mutual Servers, etc.) belong in later PRs once those features
// land — exposing them now would surface dead buttons.

function safeAvatarUrl(url: string | null): string | null {
  if (url === null) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

export function UserCardSheet() {
  const open = createMemo(() => userCard() !== null);
  const card = userCard;
  // Manage-button gate — convenience only; the runtime re-checks the permission
  // on every mutating IPC. We hide self (Q1: no self-management UI) and owner
  // targets unless the actor is also the owner (only Central transfers ownership).
  const canManagePermissions = useHasPermission("core.permissions.manage");
  const isSelf = createMemo(() => {
    const c = card();
    const acc = account();
    return !!c && !!acc && c.userId === acc.id;
  });
  const targetIsOwner = createMemo(() => {
    const c = card();
    const srv = activeServer();
    return !!c && !!srv && c.userId === srv.owner_id;
  });
  const showManageButton = createMemo(() => {
    if (!canManagePermissions()) return false;
    if (isSelf()) return false;
    if (targetIsOwner() && !isOwner()) return false;
    return true;
  });
  const color = createMemo(() => {
    const c = card();
    return c ? getClientColor(c.userId) : null;
  });
  const initial = createMemo(() => {
    const c = card();
    return c ? getNameInitial(c.displayName) : "?";
  });
  const safeUrl = createMemo(() => {
    const c = card();
    return c ? safeAvatarUrl(c.avatarUrl) : null;
  });

  return (
    <Sheet open={open()} onOpenChange={(o) => { if (!o) closeUserCard(); }}>
      <SheetContent
        side="right"
        class="flex w-[22rem] flex-col gap-0 p-0 sm:max-w-[22rem]"
      >
        <SheetHeader class="flex flex-row items-center justify-between gap-0 border-b border-border px-4 py-3">
          <SheetTitle class="text-sm font-semibold">User</SheetTitle>
          <SheetClose class="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
            <X class="size-3.5" />
          </SheetClose>
        </SheetHeader>

        <Show when={card()}>
          {(c) => (
            <div class="flex-1 overflow-y-auto">
              <div
                class="flex flex-col items-center gap-3 border-b border-border px-4 py-6"
                style={{
                  background:
                    "radial-gradient(ellipse 80% 60% at 50% 0%, color-mix(in oklch, var(--sidebar-primary) 12%, transparent), transparent)",
                }}
              >
                <div
                  class="flex size-24 items-center justify-center overflow-hidden rounded-full text-3xl font-semibold shadow-sm ring-4 ring-background"
                  style={
                    // Colored disk only renders for the no-image fallback so a
                    // user's transparent PFP composites against the sheet hero
                    // surface instead of bleeding through the deterministic hue.
                    safeUrl() === null && color()
                      ? {
                          "background-color": color()!.background,
                          color: color()!.foreground,
                        }
                      : {}
                  }
                >
                  <Show
                    when={safeUrl() !== null}
                    fallback={<span>{initial()}</span>}
                  >
                    <img
                      src={safeUrl()!}
                      alt={c().displayName}
                      class="size-full object-cover"
                      loading="lazy"
                      decoding="async"
                    />
                  </Show>
                </div>

                <div class="text-center">
                  <p class="text-lg font-semibold">{c().displayName}</p>
                  <p class="font-mono text-xs text-muted-foreground">
                    {c().userId.slice(0, 8)}
                  </p>
                </div>
              </div>

              <section class="space-y-4 px-4 py-4">
                <Show when={showManageButton()}>
                  <Button
                    variant="outline"
                    class="w-full"
                    onClick={() => {
                      openMemberManage({
                        userId: c().userId,
                        displayName: c().displayName,
                        avatarUrl: c().avatarUrl,
                      });
                      closeUserCard();
                    }}
                  >
                    <Settings2 class="size-4" />
                    Manage member
                  </Button>
                </Show>

                <p class="text-xs text-muted-foreground">
                  Direct messages and mutual-server lists arrive in a later
                  release. For now this card surfaces identity so plugins can
                  link from any avatar back to a unified profile.
                </p>
              </section>
            </div>
          )}
        </Show>
      </SheetContent>
    </Sheet>
  );
}
