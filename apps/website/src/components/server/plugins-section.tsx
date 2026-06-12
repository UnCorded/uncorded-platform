import {
  createResource,
  createSignal,
  For,
  Show,
  Switch as SwitchMatch,
  Match,
  type Component,
} from "solid-js";
import {
  ChevronDown,
  Hash,
  Loader2,
  Plug,
  Plus,
  Settings,
  Trash2,
  Volume2,
  type LucideProps,
} from "lucide-solid";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import {
  AdminPluginError,
  listPlugins,
  setPluginEnabled,
  type AdminPluginRow,
} from "@/lib/admin-plugins";
import { PluginSettingsPanel } from "./plugin-settings-panel";
import { AddPluginChooser } from "@/components/plugin-dev/add-plugin-chooser";
import { PluginDevSheet } from "@/components/plugin-dev/plugin-dev-sheet";

type IconComponent = (props: LucideProps) => ReturnType<Component>;

// Static map of lucide names supported in plugin manifests today. Plugins
// declare an icon by name (e.g. `"icon": "Hash"`); unknown names render the
// generic Plug fallback. Expand as new bundled plugins arrive.
const PLUGIN_ICON_MAP: Record<string, IconComponent> = {
  Hash: Hash as unknown as IconComponent,
  Volume2: Volume2 as unknown as IconComponent,
};

function pickPluginIcon(name: string | undefined): IconComponent {
  if (name && PLUGIN_ICON_MAP[name]) return PLUGIN_ICON_MAP[name]!;
  return Plug as unknown as IconComponent;
}

type ViewMode = { kind: "list" } | { kind: "settings"; slug: string };

interface PluginsSectionProps {
  serverId: string;
  tunnelUrl: string;
}

export const PluginsSection: Component<PluginsSectionProps> = (props) => {
  const [view, setView] = createSignal<ViewMode>({ kind: "list" });

  return (
    <Show
      when={props.tunnelUrl}
      fallback={
        <div class="flex items-center justify-center p-6">
          <p class="text-sm text-muted-foreground">Server is not yet reachable.</p>
        </div>
      }
    >
      <SwitchMatch>
        <Match when={view().kind === "list"}>
          <PluginList
            serverId={props.serverId}
            tunnelUrl={props.tunnelUrl}
            onOpenSettings={(slug) => setView({ kind: "settings", slug })}
          />
        </Match>
        <Match when={view().kind === "settings"}>
          {(() => {
            const v = view();
            if (v.kind !== "settings") return null;
            return (
              <PluginSettingsPanel
                serverId={props.serverId}
                tunnelUrl={props.tunnelUrl}
                slug={v.slug}
                onBack={() => setView({ kind: "list" })}
              />
            );
          })()}
        </Match>
      </SwitchMatch>
    </Show>
  );
};

interface PluginListProps {
  serverId: string;
  tunnelUrl: string;
  onOpenSettings: (slug: string) => void;
}

const PluginList: Component<PluginListProps> = (props) => {
  const [plugins, { refetch }] = createResource(
    () => ({ serverId: props.serverId, tunnelUrl: props.tunnelUrl }),
    ({ serverId, tunnelUrl }) => listPlugins(serverId, tunnelUrl),
  );

  const [toggleError, setToggleError] = createSignal<string | null>(null);
  const [restartHint, setRestartHint] = createSignal<string | null>(null);
  const [chooserOpen, setChooserOpen] = createSignal(false);
  const [devSheetOpen, setDevSheetOpen] = createSignal(false);

  async function handleToggle(slug: string, next: boolean): Promise<void> {
    setToggleError(null);
    setRestartHint(null);
    try {
      await setPluginEnabled(props.serverId, props.tunnelUrl, slug, next);
      await refetch();
      if (next) setRestartHint(`${slug}: restart required to take effect.`);
    } catch (err) {
      setToggleError(
        err instanceof AdminPluginError ? err.message : err instanceof Error ? err.message : "Toggle failed",
      );
    }
  }

  return (
    <div class="flex flex-col">
      <div class="flex items-center justify-between border-b border-border px-4 py-3">
        <span class="text-sm font-semibold">Installed plugins</span>
        <Button size="sm" variant="outline" onClick={() => setChooserOpen(true)}>
          <Plus class="size-4" />
          Add Plugin
        </Button>
      </div>

      <Show when={toggleError()}>
        <p class="px-4 pt-2 text-xs text-destructive">{toggleError()}</p>
      </Show>
      <Show when={restartHint()}>
        <p class="px-4 pt-2 text-xs text-muted-foreground">{restartHint()}</p>
      </Show>

      <Show
        when={!plugins.loading}
        fallback={
          <div class="flex items-center justify-center p-8">
            <Loader2 class="size-4 animate-spin text-muted-foreground" />
          </div>
        }
      >
        <Show
          when={plugins() && plugins()!.length > 0}
          fallback={
            <Show
              when={plugins.error}
              fallback={
                <p class="p-6 text-sm text-muted-foreground">No plugins installed.</p>
              }
            >
              <p class="p-6 text-sm text-destructive">
                {(plugins.error as AdminPluginError | Error)?.message ?? "Failed to load plugins."}
              </p>
            </Show>
          }
        >
          <div class="flex flex-col divide-y divide-border">
            <For each={plugins()}>
              {(plugin) => (
                <PluginRow
                  plugin={plugin}
                  onOpenSettings={() => props.onOpenSettings(plugin.slug)}
                  onToggle={(next) => handleToggle(plugin.slug, next)}
                />
              )}
            </For>
          </div>
        </Show>
      </Show>

      <AddPluginChooser
        open={chooserOpen()}
        onOpenChange={setChooserOpen}
        onDevelop={() => setDevSheetOpen(true)}
      />
      <PluginDevSheet
        open={devSheetOpen()}
        serverId={props.serverId}
        onOpenChange={(open) => {
          setDevSheetOpen(open);
          // An install in the dev flow restarts the server and changes the
          // installed set — refresh the list when the workspace closes.
          if (!open) void refetch();
        }}
      />
    </div>
  );
};

const PluginRow: Component<{
  plugin: AdminPluginRow;
  onOpenSettings: () => void;
  onToggle: (next: boolean) => void;
}> = (props) => {
  return (
    <Collapsible>
      <div class="flex items-center gap-2 px-4 py-3">
        <CollapsibleTrigger class="flex flex-1 items-center gap-3 text-left">
          {(() => {
            const Icon = pickPluginIcon(props.plugin.manifest.icon);
            return (
              <div class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Icon class="size-4" />
              </div>
            );
          })()}
          <div class="flex flex-col min-w-0">
            <span class="text-sm font-medium truncate">{props.plugin.manifest.name}</span>
            <span class="text-xs text-muted-foreground">
              v{props.plugin.manifest.version} · {props.plugin.statusLabel}
            </span>
          </div>
          <ChevronDown class="size-4 ml-auto text-muted-foreground transition-transform data-[expanded]:rotate-180" />
        </CollapsibleTrigger>
        <Button
          size="icon"
          variant="ghost"
          disabled={!props.plugin.hasSettings}
          onClick={props.onOpenSettings}
          aria-label="Settings"
          data-tooltip={
            props.plugin.hasSettings ? "Plugin settings" : "This plugin has no settings."
          }
        >
          <Settings class="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          disabled
          aria-label="Delete"
          data-tooltip="Plugin uninstall coming in a later update"
        >
          <Trash2 class="size-4" />
        </Button>
        <label class="inline-flex cursor-pointer items-center">
          <input
            type="checkbox"
            class="sr-only"
            checked={props.plugin.enabled}
            onChange={(e) => props.onToggle(e.currentTarget.checked)}
          />
          <span
            class={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              props.plugin.enabled ? "bg-primary" : "bg-muted"
            }`}
          >
            <span
              class={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-background shadow transition-transform ${
                props.plugin.enabled ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </span>
        </label>
      </div>
      <CollapsibleContent>
        <div class="flex flex-col gap-3 px-4 pb-4">
          <p class="text-xs text-muted-foreground">{props.plugin.manifest.description}</p>
          <Show when={(props.plugin.manifest.permissions?.length ?? 0) > 0}>
            <details class="text-xs">
              <summary class="cursor-pointer text-muted-foreground hover:text-foreground">
                Permissions ({props.plugin.manifest.permissions?.length ?? 0})
              </summary>
              <ul class="mt-2 flex flex-col gap-1 pl-4">
                <For each={props.plugin.manifest.permissions ?? []}>
                  {(p) => <li class="font-mono text-[11px]">{p}</li>}
                </For>
              </ul>
            </details>
          </Show>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
