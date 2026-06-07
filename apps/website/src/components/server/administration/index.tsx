// Administration tab — replaces the old "Moderation" surface (spec-22
// Amendment B PR 4). Three sub-tabs:
//   • Bans   — extracted from the original ModerationSection unchanged.
//   • Roles  — role CRUD + permission matrix.
//   • Audit  — unified ban + permission audit log with filter chips.
//
// The sub-tab strip uses the same minimal underline pattern as the original
// moderation strip so the rename feels like a renaming, not a redesign.

import { createSignal, Show } from "solid-js";
import { Ban as BanIcon, ScrollText, ShieldCheck } from "lucide-solid";
import { cn } from "@/lib/utils";
import { BansTab } from "./bans-tab";
import { RolesTab } from "./roles-tab";
import { AuditTab } from "./audit-tab";

type SubTab = "bans" | "roles" | "audit";

const SUBTABS: Array<{ id: SubTab; label: string; icon: typeof BanIcon }> = [
  { id: "bans",  label: "Bans",  icon: BanIcon     },
  { id: "roles", label: "Roles", icon: ShieldCheck },
  { id: "audit", label: "Audit", icon: ScrollText  },
];

export function AdministrationSection(props: { serverId: string }) {
  const [tab, setTab] = createSignal<SubTab>("bans");

  return (
    <div class="flex flex-col">
      <div class="flex border-b border-border px-4">
        {SUBTABS.map((t) => (
          <button
            class={cn(
              "py-2 px-1 mr-4 last:mr-0 text-xs font-medium border-b-2 transition-colors inline-flex items-center gap-1.5",
              tab() === t.id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setTab(t.id)}
          >
            <t.icon class="size-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      <Show when={tab() === "bans"}>
        <BansTab serverId={props.serverId} />
      </Show>
      <Show when={tab() === "roles"}>
        <RolesTab serverId={props.serverId} />
      </Show>
      <Show when={tab() === "audit"}>
        <AuditTab serverId={props.serverId} />
      </Show>
    </div>
  );
}
