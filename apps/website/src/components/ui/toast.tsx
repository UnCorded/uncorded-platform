import { For, Show } from "solid-js";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-solid";
import { dismissToast, toasts, type FeedbackSeverity } from "@/lib/feedback";

function ToastIcon(props: { severity: FeedbackSeverity }) {
  if (props.severity === "error") {
    return <AlertTriangle class="size-4 shrink-0 text-destructive" />;
  }
  if (props.severity === "warning") {
    return <AlertTriangle class="size-4 shrink-0 text-amber-500" />;
  }
  if (props.severity === "info") {
    return <CheckCircle2 class="size-4 shrink-0 text-emerald-500" />;
  }
  return <Info class="size-4 shrink-0 text-muted-foreground" />;
}

export function ToastViewport() {
  return (
    <Show when={toasts().length > 0}>
      <div
        aria-live="polite"
        aria-relevant="additions text"
        class="pointer-events-none absolute right-3 top-14 z-[60] flex w-[min(380px,calc(100%-1.5rem))] flex-col gap-2 sm:right-4"
      >
        <For each={toasts()}>
          {(toast) => (
            <div
              role={toast.severity === "error" ? "alert" : "status"}
              class="pointer-events-auto grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-md border bg-background/95 px-3 py-2 text-sm shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/85"
              classList={{
                "border-border text-foreground": toast.severity === "info",
                "border-amber-300/70 text-foreground dark:border-amber-700/70": toast.severity === "warning",
                "border-destructive/40 text-foreground": toast.severity === "error",
              }}
            >
              <ToastIcon severity={toast.severity} />
              <p class="min-w-0 break-words leading-5">{toast.message}</p>
              <button
                type="button"
                class="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Dismiss notification"
                onClick={() => dismissToast(toast.id)}
              >
                <X class="size-3.5" />
              </button>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
