import { createMemo, For, Match, Show, Switch as SwitchMatch, type Component } from "solid-js";
import type { PluginSetting } from "@uncorded/shared";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type SettingValue = string | number | boolean;

interface SettingControlProps {
  setting: PluginSetting;
  value: SettingValue;
  onChange: (next: SettingValue) => void;
  disabled?: boolean | undefined;
}

/**
 * Renders the right input for a manifest-declared setting.
 * - boolean: native checkbox styled as a switch
 * - number: slider + numeric input when min/max present, plain numeric otherwise
 * - string with `enum`: select
 * - string without `enum`: text input
 * - secret: password input — non-empty value shown as masked placeholder
 */
export const SettingControl: Component<SettingControlProps> = (props) => {
  return (
    <SwitchMatch>
      <Match when={props.setting.type === "boolean"}>
        <BooleanControl
          checked={typeof props.value === "boolean" ? props.value : false}
          onChange={(v) => props.onChange(v)}
          disabled={props.disabled}
        />
      </Match>
      <Match when={props.setting.type === "number"}>
        <NumberControl
          setting={props.setting}
          value={typeof props.value === "number" ? props.value : 0}
          onChange={(v) => props.onChange(v)}
          disabled={props.disabled}
        />
      </Match>
      <Match when={props.setting.type === "string" && props.setting.enum && props.setting.enum.length > 0}>
        <EnumControl
          options={props.setting.enum ?? []}
          value={typeof props.value === "string" ? props.value : ""}
          onChange={(v) => props.onChange(v)}
          disabled={props.disabled}
        />
      </Match>
      <Match when={props.setting.type === "string"}>
        <TextControl
          value={typeof props.value === "string" ? props.value : ""}
          maxLength={props.setting.max_length}
          onChange={(v) => props.onChange(v)}
          disabled={props.disabled}
        />
      </Match>
      <Match when={props.setting.type === "secret"}>
        <SecretControl
          value={typeof props.value === "string" ? props.value : ""}
          maxLength={props.setting.max_length}
          onChange={(v) => props.onChange(v)}
          disabled={props.disabled}
        />
      </Match>
    </SwitchMatch>
  );
};

function BooleanControl(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean | undefined;
}) {
  return (
    <label class="inline-flex cursor-pointer items-center gap-2">
      <span
        class={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
          props.checked ? "bg-primary" : "bg-muted",
          props.disabled ? "opacity-50" : "",
        )}
      >
        <input
          type="checkbox"
          class="absolute inset-0 cursor-pointer opacity-0"
          checked={props.checked}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
        />
        <span
          class={cn(
            "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-background shadow transition-transform",
            props.checked ? "translate-x-4" : "translate-x-0",
          )}
        />
      </span>
      <span class="text-xs text-muted-foreground">{props.checked ? "On" : "Off"}</span>
    </label>
  );
}

function NumberControl(props: {
  setting: PluginSetting;
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean | undefined;
}) {
  const stops = createMemo(() => props.setting.stops ?? null);
  const hasRange = createMemo(
    () => props.setting.min !== undefined && props.setting.max !== undefined,
  );
  const step = () => props.setting.step ?? 1;

  return (
    <Show
      when={stops()}
      fallback={
        <div class="flex w-full items-center gap-3">
          <Show when={hasRange()}>
            <input
              type="range"
              class="flex-1 accent-primary disabled:opacity-50"
              min={props.setting.min}
              max={props.setting.max}
              step={step()}
              value={props.value}
              disabled={props.disabled}
              onInput={(e) => {
                const n = Number(e.currentTarget.value);
                if (Number.isFinite(n)) props.onChange(n);
              }}
            />
          </Show>
          <Input
            type="number"
            class="w-24"
            min={props.setting.min}
            max={props.setting.max}
            step={step()}
            value={props.value}
            disabled={props.disabled}
            onInput={(e) => {
              const n = Number(e.currentTarget.value);
              if (Number.isFinite(n)) props.onChange(n);
            }}
          />
        </div>
      }
    >
      {(stopsList) => (
        <StopSlider
          stops={stopsList()}
          value={props.value}
          disabled={props.disabled}
          onChange={(v) => props.onChange(v)}
        />
      )}
    </Show>
  );
}

function StopSlider(props: {
  stops: ReadonlyArray<{ value: number; label: string }>;
  value: number;
  disabled?: boolean | undefined;
  onChange: (next: number) => void;
}) {
  // Index of the current value. If the draft doesn't match any stop exactly
  // (e.g. legacy data), snap to the closest one for slider position only —
  // never write back; the underlying value stays as-is until the user moves
  // the slider intentionally.
  const activeIndex = createMemo(() => {
    const exact = props.stops.findIndex((s) => s.value === props.value);
    if (exact !== -1) return exact;
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < props.stops.length; i++) {
      const d = Math.abs(props.stops[i]!.value - props.value);
      if (d < bestDist) {
        best = i;
        bestDist = d;
      }
    }
    return best;
  });

  return (
    <div class="flex w-full flex-col gap-1">
      <input
        type="range"
        class="w-full accent-primary disabled:opacity-50"
        min={0}
        max={props.stops.length - 1}
        step={1}
        value={activeIndex()}
        disabled={props.disabled}
        onInput={(e) => {
          const idx = Number(e.currentTarget.value);
          if (Number.isInteger(idx)) {
            const stop = props.stops[idx];
            if (stop) props.onChange(stop.value);
          }
        }}
      />
      <div class="flex justify-between gap-1 text-[11px] text-muted-foreground">
        <For each={props.stops}>
          {(stop, i) => (
            <span
              class={cn(
                "min-w-0 flex-1 text-center truncate",
                i() === 0 && "text-left",
                i() === props.stops.length - 1 && "text-right",
                i() === activeIndex() && "font-medium text-foreground",
              )}
            >
              {stop.label}
            </span>
          )}
        </For>
      </div>
    </div>
  );
}

function EnumControl(props: {
  options: string[];
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean | undefined;
}) {
  return (
    <select
      class="border border-input bg-background hover:bg-accent rounded-md px-2 h-8 text-sm w-full"
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.currentTarget.value)}
    >
      <For each={props.options}>
        {(opt) => <option value={opt}>{opt}</option>}
      </For>
    </select>
  );
}

function TextControl(props: {
  value: string;
  maxLength?: number | undefined;
  onChange: (next: string) => void;
  disabled?: boolean | undefined;
}) {
  return (
    <Input
      type="text"
      value={props.value}
      maxLength={props.maxLength}
      disabled={props.disabled}
      onInput={(e) => props.onChange(e.currentTarget.value)}
    />
  );
}

function SecretControl(props: {
  value: string;
  maxLength?: number | undefined;
  onChange: (next: string) => void;
  disabled?: boolean | undefined;
}) {
  // The runtime hands us "__redacted__" when a secret is set, and "" otherwise.
  // Surface that as a placeholder hint and start with an empty input — the
  // user types only when they want to replace.
  const isSet = () => props.value === "__redacted__";
  return (
    <Input
      type="password"
      value={isSet() ? "" : props.value}
      placeholder={isSet() ? "•••••• (set — type to replace)" : "(unset)"}
      maxLength={props.maxLength}
      disabled={props.disabled}
      onInput={(e) => props.onChange(e.currentTarget.value)}
    />
  );
}
