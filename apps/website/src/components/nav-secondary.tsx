import { type ComponentProps, type JSX, For, splitProps } from "solid-js";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export type NavSecondaryItem = {
  title: string;
  url?: string;
  icon: (props: { class?: string }) => JSX.Element;
  onClick?: () => void;
  disabled?: boolean;
};

type NavSecondaryProps = ComponentProps<typeof SidebarGroup> & {
  items: NavSecondaryItem[];
};

export function NavSecondary(props: NavSecondaryProps) {
  const [local, others] = splitProps(props, ["items"]);
  return (
    <SidebarGroup {...others}>
      <SidebarGroupContent>
        <SidebarMenu>
          <For each={local.items}>
            {(item) => (
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="sm"
                  {...(item.disabled
                    ? {
                        "aria-disabled": true,
                        title: "Coming soon",
                        // SidebarMenuButton's aria-disabled variant kills
                        // pointer events outright, which suppresses both the
                        // not-allowed cursor and the title tooltip. Re-enable
                        // hover so the user gets feedback.
                        class: "pointer-events-auto! cursor-not-allowed",
                      }
                    : {
                        ...(item.url ? { href: item.url } : {}),
                        ...(item.onClick ? { onClick: item.onClick } : {}),
                      })}
                >
                  <item.icon />
                  <span>{item.title}</span>
                  {item.disabled ? (
                    <span class="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground/40">
                      Soon
                    </span>
                  ) : null}
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </For>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
