// Per-action result schemas for the plugin SDK.
//
// Layered on top of the envelope validation in `@uncorded/protocol-schemas`:
// the boundary safeParse guarantees `{ type, id, error?, result? }` shape, but
// the *contents* of `result` are per-action and live here. Every internal SDK
// call-site passes the schema for the action it's making to `sendAndWait`,
// which validates and either returns `z.infer<S>` or throws SdkProtocolError
// with the captured Zod issues for debugging.
//
// Use `unknownResult` for actions whose response is intentionally ignored
// (broadcast, schedule.register, events.subscribe, etc.) — passing
// `z.unknown()` keeps the one signature without weakening per-action sites.

import { z } from "zod";
import {
  AuthDecisionSchema,
  PluginResourceRefSchema,
} from "@uncorded/protocol-schemas";

// ---------------------------------------------------------------------------
// Sentinel: result-not-validated (void / ignored responses)
// ---------------------------------------------------------------------------

export const unknownResult = z.unknown();

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

const CoreUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  display_name: z.string(),
  avatar_url: z.string(),
  is_online: z.boolean(),
  last_seen_at: z.number(),
  connected_at: z.number(),
});

export const CoreUserGetResult = z.object({ user: CoreUserSchema.nullable() });
export const CoreUsersResult = z.object({ users: z.array(CoreUserSchema) });

const CoreCategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const CoreCategoriesResult = z.object({
  categories: z.array(CoreCategorySchema),
});

// ---------------------------------------------------------------------------
// KV
// ---------------------------------------------------------------------------

export const KvGetResult = z.string().nullable();
export const KvListResult = z.array(z.object({ key: z.string(), value: z.string() }));
export const KvGetManyResult = z.record(z.string(), z.string());

// ---------------------------------------------------------------------------
// HTTP fetch
// ---------------------------------------------------------------------------

export const HttpFetchResult = z.object({
  status: z.number(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
  encoding: z.literal("base64"),
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export const PermissionsBoolResult = z.boolean();
export const PermissionsRoleResult = z.object({
  name: z.string(),
  level: z.number(),
});

// ---------------------------------------------------------------------------
// Presence (scoped)
// ---------------------------------------------------------------------------

const PresenceEntrySchema = z.object({
  scope: z.string(),
  user_id: z.string(),
  session_id: z.string(),
  meta: z.record(z.string(), z.unknown()),
  joined_at: z.number(),
  updated_at: z.number(),
});

export const PresenceJoinResult = z.object({
  scope: z.string(),
  joined_at: z.number(),
});
// list() is allowed to return null (no entries) per existing scoped-presence behavior.
export const PresenceListResult = z.array(PresenceEntrySchema).nullable();

// ---------------------------------------------------------------------------
// Own-database (data.sql) and cross-plugin reads (data.read)
// ---------------------------------------------------------------------------

// Rows are arbitrary `Record<string, unknown>` since the plugin chose the
// projection. We can only enforce "it's an array of objects."
const RowsResult = z.array(z.record(z.string(), z.unknown()));
export const DbQueryResult = RowsResult;
export const DataReadResult = RowsResult;

export const DbRunResult = z.object({
  changes: z.number(),
  // SQLite lastInsertRowid can exceed Number.MAX_SAFE_INTEGER → bigint.
  lastInsertRowid: z.union([z.number(), z.bigint()]),
});

export const DbBatchResult = z.array(DbRunResult);

// ---------------------------------------------------------------------------
// Voice (sdk.voice.*)
// ---------------------------------------------------------------------------

export const VoiceCreateJoinTokenResult = z.object({
  token: z.string(),
  livekitUrl: z.string(),
  expiresAt: z.number(),
});

export const VoiceRemoveParticipantResult = z.object({
  ok: z.literal(true),
});

// ---------------------------------------------------------------------------
// Plugin resources (resources.*) — RP-FOUND-4
// ---------------------------------------------------------------------------

/** `resources.define` ack. */
export const ResourceDefineResult = z.object({ ok: z.literal(true) });

/** `resources.create` → the canonical ref the runtime stamped. */
export const ResourceCreateResult = z.object({ ref: PluginResourceRefSchema });

/** `resources.grant` / `resources.revoke` → new ACL version (null if the
 *  resource row vanished, which the SDK surfaces rather than guessing). */
export const ResourceAclWriteResult = z.object({
  ok: z.literal(true),
  aclVersion: z.number().nullable(),
});

/** `resources.check` → the resolver's AuthDecision verbatim. */
export const ResourceCheckResult = AuthDecisionSchema;
