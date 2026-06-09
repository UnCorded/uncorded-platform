import {
  createEffect,
  createResource,
  For,
  Show,
  type Component,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { AlertTriangle, ChevronLeft, Loader2 } from "lucide-solid";
import type { PluginSetting } from "@uncorded/shared";
import { Button } from "@/components/ui/button";
import {
  AdminPluginError,
  approveProxyMount,
  getPluginConfig,
  patchPluginConfig,
  type ProxyMountStatus,
} from "@/lib/admin-plugins";
import { SettingControl } from "./plugin-setting-controls";
import {
  proxyStatusBadgeClass,
  proxyStatusLabel,
  proxyWarningText,
} from "./proxy-mount-status";

type SettingValue = string | number | boolean;

interface PluginSettingsPanelProps {
  serverId: string;
  tunnelUrl: string;
  slug: string;
  onBack: () => void;
}

interface RowState {
  setting: PluginSetting;
  original: SettingValue;
  draft: SettingValue;
  saving: boolean;
  error: string | null;
}

export const PluginSettingsPanel: Component<PluginSettingsPanelProps> = (props) => {
  const [config, { refetch }] = createResource(
    () => ({ serverId: props.serverId, tunnelUrl: props.tunnelUrl, slug: props.slug }),
    ({ serverId, tunnelUrl, slug }) => getPluginConfig(serverId, tunnelUrl, slug),
  );

  // Transient per-mount approval UI state (in-flight + last error), keyed by mount
  // name. Kept separate from `config()` so a re-approval refetch doesn't clobber
  // an error message and vice-versa.
  const [mountState, setMountState] = createStore<
    Record<string, { approving: boolean; error: string | null }>
  >({});

  async function approveMount(name: string): Promise<void> {
    setMountState(name, { approving: true, error: null });
    try {
      await approveProxyMount(props.serverId, props.tunnelUrl, props.slug, name);
      await refetch();
      setMountState(name, { approving: false, error: null });
    } catch (err) {
      const message =
        err instanceof AdminPluginError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Approval failed";
      setMountState(name, { approving: false, error: message });
    }
  }

  // Store-based row state — mutating a single field via produce keeps the row's
  // object identity stable, so <For> doesn't unmount the SettingControl while
  // the user is dragging a slider. (Spreading new objects under <For> tears
  // down children mid-pointer-event — see feedback_solid_for_spread_teardown.)
  const [rows, setRows] = createStore<RowState[]>([]);

  // Re-seed rows whenever the resource resolves. createEffect keeps this
  // declarative so reloads (slug change) reset cleanly.
  createEffect(() => {
    const data = config();
    if (!data) return;
    setRows(
      data.settings.map((setting) => {
        const initial = data.values[setting.key] ?? defaultFor(setting);
        return {
          setting,
          original: initial,
          draft: initial,
          saving: false,
          error: null,
        };
      }),
    );
  });

  function updateRow(key: string, patch: Partial<RowState>): void {
    setRows(
      produce((rs) => {
        const row = rs.find((r) => r.setting.key === key);
        if (row) Object.assign(row, patch);
      }),
    );
  }

  async function saveRow(key: string): Promise<void> {
    const row = rows.find((r) => r.setting.key === key);
    if (!row) return;
    const toSend = row.draft;
    if (row.setting.type === "secret" && toSend === "__redacted__") return;
    updateRow(key, { saving: true, error: null });
    try {
      await patchPluginConfig(props.serverId, props.tunnelUrl, props.slug, key, toSend);
      const newOriginal: SettingValue =
        row.setting.type === "secret"
          ? typeof toSend === "string" && toSend.length > 0
            ? "__redacted__"
            : ""
          : toSend;
      updateRow(key, { saving: false, original: newOriginal, draft: newOriginal });
    } catch (err) {
      const message =
        err instanceof AdminPluginError ? err.message : err instanceof Error ? err.message : "Save failed";
      updateRow(key, { saving: false, error: message });
    }
  }

  return (
    <div class="flex flex-col">
      <div class="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-4 py-3">
        <Button variant="ghost" size="sm" onClick={props.onBack} class="-ml-2">
          <ChevronLeft class="size-4" />
          Back
        </Button>
        <span class="text-sm font-semibold truncate">{props.slug}</span>
      </div>

      <Show
        when={!config.loading && config()}
        fallback={
          <div class="flex items-center justify-center p-8">
            <Show
              when={config.error}
              fallback={<Loader2 class="size-4 animate-spin text-muted-foreground" />}
            >
              <p class="text-sm text-destructive">
                {(config.error as AdminPluginError | Error)?.message ?? "Failed to load settings."}
              </p>
            </Show>
          </div>
        }
      >
        <Show when={(config()?.proxy_mounts ?? []).length > 0}>
          <div class="flex flex-col gap-1 border-b border-border bg-muted/30 px-4 py-3">
            <h3 class="text-sm font-semibold">Reverse-proxy mounts</h3>
            <p class="text-xs text-muted-foreground">
              Approving a mount lets members reach its upstream through this server.
              Saving settings never approves — review the target and approve explicitly.
            </p>
          </div>
          <div class="flex flex-col divide-y divide-border">
            <For each={config()?.proxy_mounts ?? []}>
              {(mount) => (
                <ProxyMountRow
                  mount={mount}
                  approving={mountState[mount.name]?.approving ?? false}
                  error={mountState[mount.name]?.error ?? null}
                  onApprove={() => approveMount(mount.name)}
                />
              )}
            </For>
          </div>
        </Show>

        <div class="flex flex-col divide-y divide-border">
          <Show
            when={rows.length > 0}
            fallback={
              <p class="p-6 text-sm text-muted-foreground">
                This plugin declares no admin-configurable settings.
              </p>
            }
          >
            <For each={rows}>
              {(row) => (
                <SettingRow
                  row={row}
                  onChange={(v) => updateRow(row.setting.key, { draft: v, error: null })}
                  onSave={() => saveRow(row.setting.key)}
                />
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
};

function SettingRow(props: {
  row: RowState;
  onChange: (next: SettingValue) => void;
  onSave: () => void;
}) {
  const isDirty = () => !sameValue(props.row.draft, props.row.original);
  return (
    <div class="flex flex-col gap-2 px-4 py-3">
      <div class="flex items-baseline justify-between gap-2">
        <label class="text-sm font-medium">{props.row.setting.label}</label>
        <Show when={props.row.setting.required}>
          <span class="text-[10px] uppercase tracking-wide text-amber-500">Required</span>
        </Show>
      </div>
      <Show when={props.row.setting.description}>
        <p class="text-xs text-muted-foreground">{props.row.setting.description}</p>
      </Show>
      <div class="flex items-center gap-2">
        <div class="flex-1">
          <SettingControl
            setting={props.row.setting}
            value={props.row.draft}
            onChange={props.onChange}
            disabled={props.row.saving}
          />
        </div>
        <Show when={isDirty()}>
          <Button size="sm" onClick={props.onSave} disabled={props.row.saving}>
            <Show when={props.row.saving} fallback="Save">
              <Loader2 class="size-4 animate-spin" />
            </Show>
          </Button>
        </Show>
      </div>
      <Show when={props.row.error}>
        <p class="text-xs text-destructive">{props.row.error}</p>
      </Show>
    </div>
  );
}

function ProxyMountRow(props: {
  mount: ProxyMountStatus;
  approving: boolean;
  error: string | null;
  onApprove: () => void;
}) {
  // Invalid mounts have no usable upstream to approve. Everything else (pending,
  // drifted, even already-approved) supports an explicit (re-)approve action.
  const canApprove = () => props.mount.status !== "invalid";
  const approveLabel = () => (props.mount.status === "approved" ? "Re-approve" : "Approve");
  return (
    <div class="flex flex-col gap-2 px-4 py-3">
      <div class="flex items-baseline justify-between gap-2">
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium">{props.mount.name}</span>
          <span
            class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${proxyStatusBadgeClass(props.mount.status)}`}
          >
            {proxyStatusLabel(props.mount.status)}
          </span>
        </div>
        <span class="text-[10px] uppercase tracking-wide text-muted-foreground">
          {props.mount.access === "owner" ? "Owner only" : "Members"}
        </span>
      </div>

      <p class="font-mono text-xs text-muted-foreground break-all">
        {props.mount.normalized_upstream ?? "No valid upstream configured."}
      </p>

      <Show when={props.mount.warning}>
        {(warning) => (
          <div class="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
            <AlertTriangle class="mt-0.5 size-3.5 shrink-0 text-amber-500" />
            <p class="text-xs text-amber-600 dark:text-amber-400">
              {proxyWarningText(warning())}
            </p>
          </div>
        )}
      </Show>

      <div class="flex items-center gap-2">
        <Show when={canApprove()}>
          <Button size="sm" onClick={props.onApprove} disabled={props.approving}>
            <Show when={props.approving} fallback={approveLabel()}>
              <Loader2 class="size-4 animate-spin" />
            </Show>
          </Button>
        </Show>
      </div>

      <Show when={props.error}>
        <p class="text-xs text-destructive">{props.error}</p>
      </Show>
    </div>
  );
}

function sameValue(a: SettingValue, b: SettingValue): boolean {
  if (typeof a !== typeof b) return false;
  return a === b;
}

function defaultFor(setting: PluginSetting): SettingValue {
  if (setting.default !== undefined) return setting.default;
  if (setting.type === "boolean") return false;
  if (setting.type === "number") return 0;
  return "";
}
