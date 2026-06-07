import { createSignal } from "solid-js";

export type FeedbackSeverity = "info" | "warning" | "error";

export interface Toast {
  id: number;
  message: string;
  severity: FeedbackSeverity;
  createdAt: number;
}

export type InlineStatus = Toast;

export interface ToastOptions {
  dismissMs?: number;
}

const MAX_VISIBLE_TOASTS = 4;
const DEFAULT_DISMISS_MS: Record<FeedbackSeverity, number> = {
  info: 4000,
  warning: 6000,
  error: 7000,
};

const [toasts, setToasts] = createSignal<Toast[]>([]);
export { toasts };

export const inlineStatus = () => toasts()[0] ?? null;

let nextId = 1;
const dismissTimers = new Map<number, ReturnType<typeof setTimeout>>();

function clearDismissTimer(id: number): void {
  const timer = dismissTimers.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  dismissTimers.delete(id);
}

function scheduleDismiss(id: number, dismissMs: number): void {
  clearDismissTimer(id);
  if (dismissMs <= 0) return;
  dismissTimers.set(
    id,
    setTimeout(() => {
      dismissTimers.delete(id);
      dismissToast(id);
    }, dismissMs),
  );
}

export function showToast(
  message: string,
  severity: FeedbackSeverity = "info",
  options: ToastOptions = {},
): number {
  const text = message.trim();
  if (text.length === 0) return -1;

  const dismissMs = options.dismissMs ?? DEFAULT_DISMISS_MS[severity];
  const now = Date.now();
  let id = -1;

  setToasts((current) => {
    const existing = current.find((toast) => toast.message === text && toast.severity === severity);
    if (existing !== undefined) {
      id = existing.id;
      return [
        { ...existing, createdAt: now },
        ...current.filter((toast) => toast.id !== existing.id),
      ];
    }

    id = nextId++;
    const next = [{ id, message: text, severity, createdAt: now }, ...current];
    const visible = next.slice(0, MAX_VISIBLE_TOASTS);
    for (const toast of next.slice(MAX_VISIBLE_TOASTS)) {
      clearDismissTimer(toast.id);
    }
    return visible;
  });

  scheduleDismiss(id, dismissMs);
  return id;
}

export function dismissToast(id: number): void {
  clearDismissTimer(id);
  setToasts((current) => current.filter((toast) => toast.id !== id));
}

export function clearToasts(): void {
  for (const id of dismissTimers.keys()) {
    clearDismissTimer(id);
  }
  setToasts([]);
}

/**
 * Backwards-compatible app feedback entry point. Existing call sites still say
 * "inline status", but the shared renderer now displays these as toasts.
 */
export function showInlineStatus(
  message: string,
  severity: FeedbackSeverity = "info",
  dismissMs?: number,
): void {
  if (dismissMs === undefined) {
    showToast(message, severity);
  } else {
    showToast(message, severity, { dismissMs });
  }
}

/** Dismiss all visible feedback immediately. */
export function clearInlineStatus(): void {
  clearToasts();
}
