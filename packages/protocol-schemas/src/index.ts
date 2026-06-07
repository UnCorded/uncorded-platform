// Wire-protocol runtime validation.
//
// Sibling to `@uncorded/protocol`, which is type-only. We keep zod out of the
// type package so type-only consumers (a future docs site, etc.) don't pull a
// runtime validator they don't need. Every boundary that deserializes
// untrusted bytes — runtime IPC stdio, plugin SDK stdio dispatcher, website
// WS message handler — imports schemas from here and `safeParse`s before
// dispatch.
//
// Coverage tier: this file does *envelope* validation for the loose
// `IpcMessage` union (the protocol envelope is `{ type: string; id?: string;
// [key: string]: unknown }` so we can only enforce the envelope shape) and
// *discriminated-union* validation for the tight `ClientMessage` /
// `ServerMessage` unions plus the runtime-to-plugin subset of IPC messages
// the plugin SDK dispatcher actually routes on. Per-action result payload
// validation is layered on top in `@uncorded/plugin-sdk/schemas` (2.3).

import { z } from "zod";
import type {
  ClientMessage,
  ServerMessage,
  IpcMessage,
  IpcRequestMessage,
  IpcResponseMessage,
  IpcEventAckMessage,
  IpcEventDeliverMessage,
} from "@uncorded/protocol";

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

const ResponseErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

// ---------------------------------------------------------------------------
// Client → Server (WebSocket)
// ---------------------------------------------------------------------------

const AuthMessageSchema = z.object({
  type: z.literal("auth"),
  token: z.string(),
});

const RequestMessageSchema = z.object({
  type: z.literal("request"),
  id: z.string(),
  plugin: z.string(),
  action: z.string(),
  params: z.record(z.string(), z.unknown()),
});

export const ClientMessageSchema: z.ZodType<ClientMessage> = z.discriminatedUnion("type", [
  AuthMessageSchema,
  RequestMessageSchema,
]);

// ---------------------------------------------------------------------------
// Server → Client (WebSocket)
// ---------------------------------------------------------------------------

const AuthResultMessageSchema = z.object({
  type: z.literal("auth.result"),
  ok: z.boolean(),
  error: z.string().optional(),
});

const ResponseMessageSchema = z.object({
  type: z.literal("response"),
  id: z.string(),
  result: z.unknown().optional(),
  error: ResponseErrorSchema.optional(),
});

const EventMessageSchema = z.object({
  type: z.literal("event"),
  topic: z.string(),
  payload: z.unknown(),
});

// ---------------------------------------------------------------------------
// Co-View Sessions (spec-27) — server→client frames the website dispatches.
// PR-CV5 turns these on for the website wire layer; before this PR every
// co-view frame was silently dropped by ServerMessageSchema.safeParse because
// the discriminated union didn't list any of them. The runtime side has its
// own narrow `isCoViewClientMessage` switch and does not consult this file
// for inbound validation.
// ---------------------------------------------------------------------------

const CoViewVisibilitySchema = z.enum(["public", "private"]);
const CoViewRenderModeSchema = z.enum(["as-host", "as-viewer"]);
const CoViewReplaySafetySchema = z.enum(["safe", "unsafe"]);
const CoViewCursorStateSchema = z.enum([
  "idle",
  "hover",
  "pressed",
  "dragging",
  "typing",
  "selecting",
  "menu-open",
  "tap",
  "long-press",
]);
const CoViewMemberLeftReasonSchema = z.enum([
  "explicit",
  "session_closed",
  "kicked",
  "host_ended",
  "no_longer_invited",
  "blacklisted_mid_session",
]);
const CoViewEndReasonSchema = z.enum([
  "host_ended",
  "host_lost",
  "host_permission_revoked",
  "host_banned",
]);

const CoViewSessionSummarySchema = z.object({
  session_id: z.string(),
  server_id: z.string(),
  host_user_id: z.string(),
  host_session_id: z.string(),
  host_display_name: z.string(),
  visibility: CoViewVisibilitySchema,
  render_mode: CoViewRenderModeSchema,
  started_at: z.number(),
  viewer_count: z.number(),
  paused: z.boolean(),
});

const WsCoViewStartAckSchema = z.object({
  type: z.literal("co-view.start.ack"),
  session_id: z.string(),
  host_color: z.string(),
});

const WsCoViewStartNakSchema = z.object({
  type: z.literal("co-view.start.nak"),
  code: z.enum(["permission_denied", "already_hosting", "invalid_payload"]),
  message: z.string(),
});

const WsCoViewUpdateAckSchema = z.object({
  type: z.literal("co-view.update.ack"),
  session_id: z.string(),
});

const WsCoViewUpdateNakSchema = z.object({
  type: z.literal("co-view.update.nak"),
  session_id: z.string(),
  code: z.enum(["not_host", "session_not_found", "invalid_payload"]),
  message: z.string(),
});

const WsCoViewEndAckSchema = z.object({
  type: z.literal("co-view.end.ack"),
  session_id: z.string(),
});

const WsCoViewJoinAckSchema = z.object({
  type: z.literal("co-view.join.ack"),
  session_id: z.string(),
  host_user_id: z.string(),
  render_mode: CoViewRenderModeSchema,
  viewer_color: z.string(),
  current_state_snapshot: z.record(z.string(), z.unknown()).nullable(),
});

const WsCoViewJoinNakSchema = z.object({
  type: z.literal("co-view.join.nak"),
  session_id: z.string(),
  code: z.enum(["session_not_found", "session_full", "blacklisted", "not_invited"]),
  message: z.string(),
});

const WsCoViewLeaveAckSchema = z.object({
  type: z.literal("co-view.leave.ack"),
  session_id: z.string(),
});

const WsCoViewKickAckSchema = z.object({
  type: z.literal("co-view.kick.ack"),
  session_id: z.string(),
  target_user_id: z.string(),
});

const WsCoViewKickNakSchema = z.object({
  type: z.literal("co-view.kick.nak"),
  session_id: z.string(),
  code: z.enum(["not_host_or_moderator", "session_not_found", "target_not_in_session"]),
  message: z.string(),
});

const WsCoViewListResSchema = z.object({
  type: z.literal("co-view.list.res"),
  request_id: z.string(),
  server_id: z.string(),
  sessions: z.array(CoViewSessionSummarySchema),
});

const WsCoViewListChangedSchema = z.object({
  type: z.literal("co-view.list.changed"),
  server_id: z.string(),
  change: z.enum(["added", "updated", "removed"]),
  session_id: z.string(),
  session: CoViewSessionSummarySchema.optional(),
});

const WsCoViewEndedSchema = z.object({
  type: z.literal("co-view.ended"),
  session_id: z.string(),
  reason: CoViewEndReasonSchema,
});

const WsCoViewMemberJoinedSchema = z.object({
  type: z.literal("co-view.member.joined"),
  session_id: z.string(),
  user_id: z.string(),
  member_id: z.string().optional(),
  color: z.string(),
});

const WsCoViewMemberLeftSchema = z.object({
  type: z.literal("co-view.member.left"),
  session_id: z.string(),
  user_id: z.string(),
  member_id: z.string().optional(),
  reason: CoViewMemberLeftReasonSchema,
});

const WsCoViewStateSchema = z.object({
  type: z.literal("co-view.state"),
  session_id: z.string(),
  seq: z.number(),
  diff: z.record(z.string(), z.unknown()),
  replay: CoViewReplaySafetySchema,
  ts: z.number(),
  full_state: z.record(z.string(), z.unknown()).optional(),
});

const CoViewEventKindSchema = z.enum([
  "nav.route_change",
  "nav.panel_open",
  "nav.panel_close",
  "nav.modal_open",
  "nav.modal_close",
  "nav.popover_open",
  "nav.popover_close",
  "nav.context_menu_open",
  "nav.context_menu_close",
  "host.action_observed",
  "pen.stroke_begin",
  "pen.stroke_point",
  "pen.stroke_end",
  "pen.clear",
]);

const WsCoViewEventSchema = z.object({
  type: z.literal("co-view.event"),
  session_id: z.string(),
  kind: CoViewEventKindSchema,
  payload: z.record(z.string(), z.unknown()),
  replay: CoViewReplaySafetySchema,
  ts: z.number(),
  member_id: z.string().optional(),
});

const WsCoViewCursorSchema = z.object({
  type: z.literal("co-view.cursor"),
  session_id: z.string(),
  member_id: z.string().optional(),
  x: z.number(),
  y: z.number(),
  state: CoViewCursorStateSchema,
  ts: z.number(),
});

const WsCoViewSnapshotReqSchema = z.object({
  type: z.literal("co-view.snapshot.req"),
  session_id: z.string(),
  since_seq: z.number(),
  member_id: z.string().optional(),
});

const WsCoViewSnapshotResSchema = z.object({
  type: z.literal("co-view.snapshot.res"),
  session_id: z.string(),
  member_id: z.string().optional(),
  seq: z.number(),
  diffs: z.array(WsCoViewStateSchema).optional(),
  full_state: z.record(z.string(), z.unknown()).optional(),
});

export const ServerMessageSchema: z.ZodType<ServerMessage> = z.discriminatedUnion("type", [
  AuthResultMessageSchema,
  ResponseMessageSchema,
  EventMessageSchema,
  WsCoViewStartAckSchema,
  WsCoViewStartNakSchema,
  WsCoViewUpdateAckSchema,
  WsCoViewUpdateNakSchema,
  WsCoViewEndAckSchema,
  WsCoViewJoinAckSchema,
  WsCoViewJoinNakSchema,
  WsCoViewLeaveAckSchema,
  WsCoViewKickAckSchema,
  WsCoViewKickNakSchema,
  WsCoViewListResSchema,
  WsCoViewListChangedSchema,
  WsCoViewEndedSchema,
  WsCoViewMemberJoinedSchema,
  WsCoViewMemberLeftSchema,
  WsCoViewStateSchema,
  WsCoViewEventSchema,
  WsCoViewCursorSchema,
  WsCoViewSnapshotReqSchema,
  WsCoViewSnapshotResSchema,
]);

// ---------------------------------------------------------------------------
// IPC envelope (Runtime ↔ Plugin)
// ---------------------------------------------------------------------------

// The IpcMessage type is intentionally open-shaped (`[key: string]: unknown`)
// so plugins can add per-action params without growing the protocol package.
// At the boundary we can only require the envelope: `type` is a non-empty
// string, `id` (if present) is a string. `passthrough` lets the rest through.
export const IpcMessageSchema: z.ZodType<IpcMessage> = z
  .looseObject({
    type: z.string().min(1),
    id: z.string().optional(),
  })
  .transform((obj) => obj as IpcMessage);

// ---------------------------------------------------------------------------
// Runtime → Plugin: tight schemas for the SDK dispatcher
// ---------------------------------------------------------------------------

const IpcUserSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  avatarUrl: z.string(),
  role: z.string(),
});

const IpcRequestMessageSchema = z.object({
  type: z.literal("request"),
  id: z.string(),
  action: z.string(),
  params: z.record(z.string(), z.unknown()),
  user: IpcUserSchema,
  session_id: z.string().optional(),
}) satisfies z.ZodType<IpcRequestMessage>;

const IpcResponseMessageSchema = z.object({
  type: z.literal("response"),
  id: z.string(),
  result: z.unknown().optional(),
  error: ResponseErrorSchema.optional(),
}) satisfies z.ZodType<IpcResponseMessage>;

const IpcEventAckMessageSchema = z.object({
  type: z.literal("event.ack"),
  id: z.string(),
  ok: z.boolean(),
  event_id: z.string().optional(),
  error: ResponseErrorSchema.optional(),
}) satisfies z.ZodType<IpcEventAckMessage>;

const IpcEventDeliverMessageSchema = z.object({
  type: z.literal("event.deliver"),
  topic: z.string(),
  version: z.number(),
  id: z.string(),
  ts: z.number(),
  source_plugin: z.string(),
  payload: z.unknown(),
}) satisfies z.ZodType<IpcEventDeliverMessage>;

const IpcPingMessageSchema = z.object({
  type: z.literal("ping"),
});

const IpcFileUploadedMessageSchema = z.object({
  type: z.literal("file.uploaded"),
  filename: z.string(),
  path: z.string(),
  size: z.number(),
  mimeType: z.string(),
  uploadedBy: z.string(),
  uploadedAt: z.number(),
});

const IpcPluginConfigChangedMessageSchema = z.object({
  type: z.literal("core.plugin.config_changed"),
  key: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
  changed_by_user_id: z.string(),
  ts: z.number(),
});

/**
 * The set of message `type`s the SDK dispatcher in `plugin.ts` actually routes
 * on. Anything else is silently dropped (matches existing dispatcher behavior)
 * so unknown types don't fail the boundary parse — only known-shape mismatches
 * do.
 */
export const RuntimeToPluginMessageSchema = z.discriminatedUnion("type", [
  IpcRequestMessageSchema,
  IpcResponseMessageSchema,
  IpcEventAckMessageSchema,
  IpcEventDeliverMessageSchema,
  IpcPingMessageSchema,
  IpcFileUploadedMessageSchema,
  IpcPluginConfigChangedMessageSchema,
]);
