// User-card store — single-instance signal that the shell's UserCardSheet
// reads from. Anywhere a user avatar is rendered (sidebar voice presence,
// future text-channels iframe, voice-channels iframe, etc.) opens the card
// by calling `openUserCard({ userId, displayName, avatarUrl })`. The sheet
// reads the signal reactively and slides in.
//
// The card payload is what the *caller* already knows about the user — we
// don't fetch in this store. Future iterations can layer a profile-fetch
// effect on top (look up shared mutual-server membership, status, etc.)
// without changing the call sites.

import { createSignal } from "solid-js";

export interface UserCard {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

const [card, setCard] = createSignal<UserCard | null>(null);

export const userCard = card;

export function openUserCard(next: UserCard): void {
  setCard(next);
}

export function closeUserCard(): void {
  setCard(null);
}
