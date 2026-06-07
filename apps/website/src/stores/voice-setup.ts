// Voice setup modal store — single source of "is the setup modal open and for
// which server". The modal is shell-owned (rendered at App root) so any
// surface that wants to trigger it (sidebar item click, voice plugin
// `platform.voice.request-setup` envelope, settings menu entry) just calls
// `openVoiceSetup(serverId)`. Owner-vs-non-owner UX branches inside the
// modal component, not at the call site — so the same trigger fits both.

import { createSignal } from "solid-js";

import { onRequestSetup } from "@/lib/voice-manager";

const [serverIdSignal, setServerIdSignal] = createSignal<string | null>(null);

export const voiceSetupServerId = serverIdSignal;

export function openVoiceSetup(serverId: string): void {
  setServerIdSignal(serverId);
}

export function closeVoiceSetup(): void {
  setServerIdSignal(null);
}

let wired = false;

/** Wire the iframe-side `platform.voice.request-setup` envelope to the modal.
 *  Idempotent — safe to call from App's onMount even on hot reload. */
export function mountVoiceSetupBridge(): void {
  if (wired) return;
  wired = true;
  onRequestSetup((serverId) => openVoiceSetup(serverId));
}
