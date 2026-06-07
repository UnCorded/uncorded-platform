import { createSignal } from "solid-js";
import { BadgeCheck, Bell, ChevronsUpDown, LogOut } from "lucide-solid";
import { Avatar } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { account, logout } from "@/stores/auth";
import { ProfileSheet } from "@/components/profile/profile-sheet";

export function NavUser() {
  const { isMobile } = useSidebar();
  const [profileOpen, setProfileOpen] = createSignal(false);

  const displayName = () => account()?.display_name ?? "";
  const username = () => {
    const email = account()?.email ?? "";
    return "@" + (email.split("@")[0] ?? email);
  };
  const userId = () => account()?.id ?? "";
  // The enhanced Avatar primitive handles `safeAvatarUrl` filtering itself,
  // so we can pass the raw value through.
  const avatarUrl = () => account()?.avatar_url ?? null;

  return (
    <>
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            as={SidebarMenuButton as any}
            size="lg"
            class="data-[expanded]:bg-sidebar-accent data-[expanded]:text-sidebar-accent-foreground"
          >
            <Avatar
              class="size-8 rounded-lg"
              userId={userId()}
              name={displayName()}
              src={avatarUrl()}
            />
            <div class="grid flex-1 text-left text-sm leading-tight">
              <span class="truncate font-semibold">{displayName()}</span>
              <span class="truncate text-xs text-muted-foreground">{username()}</span>
            </div>
            <ChevronsUpDown class="ml-auto size-4" />
          </DropdownMenuTrigger>

          <DropdownMenuContent
            class="w-(--kb-popper-anchor-width) min-w-56 rounded-lg"
            side={isMobile() ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel class="p-0 font-normal">
              <div class="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar
                  class="size-8 rounded-lg"
                  userId={userId()}
                  name={displayName()}
                  src={avatarUrl()}
                />
                <div class="grid flex-1 text-left text-sm leading-tight">
                  <span class="truncate font-semibold">{displayName()}</span>
                  <span class="truncate text-xs text-muted-foreground">{username()}</span>
                </div>
              </div>
            </DropdownMenuLabel>

            <DropdownMenuSeparator />

            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => setProfileOpen(true)}>
                <BadgeCheck class="size-4" />
                Account
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Bell class="size-4" />
                Notifications
              </DropdownMenuItem>
            </DropdownMenuGroup>

            <DropdownMenuSeparator />

            <DropdownMenuItem onSelect={() => void logout()}>
              <LogOut class="size-4" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>

    <ProfileSheet open={profileOpen()} onOpenChange={setProfileOpen} />
    </>
  );
}
