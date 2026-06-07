// Deterministic member-color assignment for Co-View Sessions.
//
// Each member's `color` is derived from `hash(session_id + member_id)` and
// projected onto the canonical 37-hue HSL palette in `@uncorded/shared` so that
// runtime, web client, and plugin SDK all paint the same hue for the same id.
//
// The wire-broadcast color is the saturated `accent` variant from
// `getClientColor`, which contrasts well against arbitrary UI panels (the
// pastel `background` variant is what avatars use; pen strokes and cursor
// outlines need the more saturated accent).

import { getClientColorString } from "@uncorded/shared";

export function pickMemberColor(sessionId: string, memberKey: string): string {
  return getClientColorString(`${sessionId}|${memberKey}`);
}
