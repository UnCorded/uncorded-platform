// Pure source-derivation helper for the `voice.join` handler. Extracted so
// the trust-boundary logic — the *only* authorization point in the chain
// per PR-6 §14 — can be unit-tested in isolation, without spinning up the
// full plugin SDK.
//
// Inputs are derived server-side: `channel.e2ee` from the channels table,
// `hasShareScreenPermission` from `plugin.permissions.check(user.id, "voice.screen_share.publish")`.
// By construction this function takes no `params` argument, so no client-supplied
// `canPublishSources` value can reach it. The handler in index.ts must derive
// these inputs from authenticated state and never read `params["canPublishSources"]`.

/** LiveKit `TrackSource` strings the plugin can grant. Mirrors the runtime
 *  allowlist (`runtime/src/voice/tokens.ts:VALID_TRACK_SOURCES`). */
export type VoiceTrackSource =
  | "microphone"
  | "camera"
  | "screen_share"
  | "screen_share_audio";

export interface SourceDerivationInputs {
  /** True when the channel has track-level encryption enabled. PR-6 §15:
   *  screen-share is refused on E2EE channels until track-level video
   *  encryption ships in PR-7. */
  channelE2ee: boolean;
  /** Result of `plugin.permissions.check(user.id, "voice.screen_share.publish")`.
   *  Server-derived; client can never set this. */
  hasShareScreenPermission: boolean;
}

/**
 * Derive the LiveKit `canPublishSources` claim for a `voice.join` token mint.
 * Pure function: same inputs → same outputs, no side effects.
 *
 * Rules (PR-6 §14):
 *   - Microphone is always allowed (audio-only join always works).
 *   - Screen + screen_audio are allowed when the user has the
 *     `voice.screen_share.publish` permission AND the channel is not E2EE.
 *   - Camera is never allowed (PR-6 ships screen content only).
 */
export function deriveCanPublishSources(
  inputs: SourceDerivationInputs,
): VoiceTrackSource[] {
  const canShareScreen =
    !inputs.channelE2ee && inputs.hasShareScreenPermission;
  return canShareScreen
    ? ["microphone", "screen_share", "screen_share_audio"]
    : ["microphone"];
}
