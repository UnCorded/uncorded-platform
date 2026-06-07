// Desktop-wide notifications store — surfaces stale-server warnings, friend
// requests, system messages, etc. as cards in the titlebar bell panel.
//
// This is intentionally a thin store: add/dismiss/clear and a reactive list.
// Producers (e.g. runtime-update watcher, central event subscriber, plugin
// SDK bridge) push notifications in; the bell panel reads them out. Keeping
// the surface narrow lets future producers ship without coordinating on a
// schema upgrade.

import { createSignal } from "solid-js";

export type NotificationAction = {
  /** Pill label, e.g. "UPDATE NOW". Kept short — long labels truncate. */
  label: string;
  /** Click handler; returning false (or throwing) leaves the notification in
   *  place, anything else dismisses it. Use for irreversible flows where
   *  the notification is the only visible reminder until the action lands. */
  onClick: () => void | boolean | Promise<void | boolean>;
  /** Visual emphasis. "primary" = filled accent, "warning" = amber. */
  tone?: "primary" | "warning";
};

export type NotificationKind = "info" | "warning" | "error";

export type Notification = {
  id: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  /** Optional source label rendered as a small chip — e.g. server name,
   *  plugin slug. Helps the user attribute a notification at a glance. */
  source?: string;
  action?: NotificationAction;
  createdAt: number;
};

const [notifications, setNotifications] = createSignal<Notification[]>([]);

export { notifications };

export function unreadCount(): number {
  return notifications().length;
}

export function addNotification(
  input: Omit<Notification, "id" | "createdAt"> & { id?: string },
): string {
  const id = input.id ?? `n_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`;
  const next: Notification = {
    id,
    kind: input.kind,
    title: input.title,
    createdAt: Date.now(),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.action !== undefined ? { action: input.action } : {}),
  };
  setNotifications((prev) => {
    // Replace by id when the same id is pushed twice (idempotent producers).
    const without = prev.filter((n) => n.id !== id);
    return [next, ...without];
  });
  return id;
}

export function dismissNotification(id: string): void {
  setNotifications((prev) => prev.filter((n) => n.id !== id));
}

export function clearAllNotifications(): void {
  setNotifications([]);
}
