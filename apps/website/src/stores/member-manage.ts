// Single-instance signal that the shell's MemberManageSheet reads from.
// Opened from user-card-sheet's "Manage member" button after the actor's
// `core.permissions.manage` gate passes (spec-22 Amendment B PR 3).
//
// The card payload is what the *caller* already knows about the user; the
// sheet itself fetches the live role list and current assignment over WS.
// We don't try to share a payload with user-card.ts because the two sheets
// disagree on lifecycle (the user card closes the moment Manage opens).

import { createSignal } from "solid-js";

export interface MemberManageTarget {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

const [target, setTarget] = createSignal<MemberManageTarget | null>(null);

export const memberManageTarget = target;

export function openMemberManage(next: MemberManageTarget): void {
  setTarget(next);
}

export function closeMemberManage(): void {
  setTarget(null);
}
