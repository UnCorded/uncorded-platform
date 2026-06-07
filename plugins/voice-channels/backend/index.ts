import { createPlugin } from "@uncorded/plugin-sdk";
import { deriveCanPublishSources } from "./voice-join";
import { redactReachability } from "./reachability-redact";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// spec-24 §Bounds. The plugin enforces these alongside the SQL CHECK so that
// a more specific error code surfaces before SQLite rejects the row.
const MAX_PARTICIPANTS_CEILING = 99;
const MAX_PARTICIPANTS_DEFAULT = 25;
const BITRATE_KBPS_MIN = 8;
const BITRATE_KBPS_MAX = 256;
const BITRATE_KBPS_DEFAULT = 64;
// PR-6 §13: per-channel screen-share publisher cap. Independent from the
// participant cap because most participants in a room are listeners, not
// publishers. Default 10 fits a single SFU on consumer hardware
// (~20 Mbps + ~1 core).
const MAX_PUBLISHERS_CEILING = 99;
const MAX_PUBLISHERS_DEFAULT = 10;

// PR-6 §1 — default level for the screen-share publish permission. 0 means
// every authenticated room member can publish (matches the user's product
// intent: "all users should be able to stream"). Server admins can raise the
// floor per-server via the permissions UI if abuse becomes a problem.
const SCREEN_SHARE_PUBLISH_DEFAULT_LEVEL = 0;
// Admin "Stop their share" — same default tier as channel admin (80) so the
// permission falls naturally to the moderator role.
const MODERATION_STOP_SHARE_DEFAULT_LEVEL = 80;

const CHANNEL_COLUMNS =
  "id, name, created_at, category_id, position, max_participants, bitrate_kbps, e2ee, max_publishers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChannelRow {
  id: string;
  name: string;
  created_at: number;
  category_id: string | null;
  position: number;
  max_participants: number;
  bitrate_kbps: number;
  // SQLite stores booleans as integers; we widen on read.
  e2ee: number;
  max_publishers: number;
}

interface Channel {
  id: string;
  name: string;
  created_at: number;
  category_id: string | null;
  position: number;
  max_participants: number;
  bitrate_kbps: number;
  e2ee: boolean;
  max_publishers: number;
}

function rowToChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    category_id: row.category_id,
    position: row.position,
    max_participants: row.max_participants,
    bitrate_kbps: row.bitrate_kbps,
    e2ee: row.e2ee === 1,
    max_publishers: row.max_publishers,
  };
}

// ---------------------------------------------------------------------------
// Plugin init
// ---------------------------------------------------------------------------

const plugin = createPlugin();

async function isValidCategoryId(id: string): Promise<boolean> {
  const categories = await plugin.core.listCategories();
  return categories.some((c) => c.id === id);
}

function clampParticipants(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return MAX_PARTICIPANTS_DEFAULT;
  return Math.max(1, Math.min(MAX_PARTICIPANTS_CEILING, raw));
}

function clampBitrate(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return BITRATE_KBPS_DEFAULT;
  return Math.max(BITRATE_KBPS_MIN, Math.min(BITRATE_KBPS_MAX, raw));
}

function clampPublishers(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return MAX_PUBLISHERS_DEFAULT;
  return Math.max(1, Math.min(MAX_PUBLISHERS_CEILING, raw));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

plugin.handle("getChannels", async () => {
  const rows = await plugin.db.query<ChannelRow>(
    `SELECT ${CHANNEL_COLUMNS} FROM channels ORDER BY position ASC, created_at ASC`,
  );
  return rows.map(rowToChannel);
});

plugin.handle("createChannel", async (params, user) => {
  const allowed = await plugin.permissions.hasMinLevel(user.id, 80);
  if (!allowed) {
    throw new Error("Insufficient permissions: voice channel creation requires admin or above");
  }

  const name = params["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("name is required and must be a non-empty string");
  }

  const rawCategoryId = params["category_id"];
  const categoryId =
    typeof rawCategoryId === "string" && rawCategoryId.length > 0 ? rawCategoryId : null;
  if (categoryId !== null && !(await isValidCategoryId(categoryId))) {
    throw new Error("UNKNOWN_CATEGORY");
  }

  const maxParticipants = clampParticipants(params["max_participants"]);
  const bitrateKbps = clampBitrate(params["bitrate_kbps"]);
  const e2ee = params["e2ee"] === true;
  const maxPublishers = clampPublishers(params["max_publishers"]);

  const positionRows = await plugin.db.query<{ max: number | null }>(
    categoryId === null
      ? "SELECT MAX(position) AS max FROM channels WHERE category_id IS NULL"
      : "SELECT MAX(position) AS max FROM channels WHERE category_id = ?",
    categoryId === null ? [] : [categoryId],
  );
  const position = (positionRows[0]?.max ?? -1) + 1;

  const id = crypto.randomUUID();
  const now = Date.now();
  await plugin.db.run(
    `INSERT INTO channels (id, name, created_at, category_id, position, max_participants, bitrate_kbps, e2ee, max_publishers)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, now, categoryId, position, maxParticipants, bitrateKbps, e2ee ? 1 : 0, maxPublishers],
  );

  const channel: Channel = {
    id,
    name,
    created_at: now,
    category_id: categoryId,
    position,
    max_participants: maxParticipants,
    bitrate_kbps: bitrateKbps,
    e2ee,
    max_publishers: maxPublishers,
  };
  plugin.events.publish("voice-channels.channel.created", channel);
  return channel;
});

plugin.handle("updateChannel", async (params, user) => {
  const allowed = await plugin.permissions.hasMinLevel(user.id, 80);
  if (!allowed) {
    throw new Error("Insufficient permissions: voice channel updates require admin or above");
  }

  const id = params["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("id is required");
  }

  const existing = await plugin.db.query<ChannelRow>(
    `SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ?`,
    [id],
  );
  const current = existing[0];
  if (!current) throw new Error("UNKNOWN_CHANNEL");

  const sets: string[] = [];
  const args: Array<string | number | null> = [];
  let next = rowToChannel(current);

  if (Object.prototype.hasOwnProperty.call(params, "name")) {
    const name = params["name"];
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("name must be a non-empty string");
    }
    sets.push("name = ?");
    args.push(name);
    next = { ...next, name };
  }

  if (Object.prototype.hasOwnProperty.call(params, "category_id")) {
    const raw = params["category_id"];
    const newCategoryId = typeof raw === "string" && raw.length > 0 ? raw : null;
    if (newCategoryId !== null && !(await isValidCategoryId(newCategoryId))) {
      throw new Error("UNKNOWN_CATEGORY");
    }
    if (newCategoryId !== current.category_id) {
      const positionRows = await plugin.db.query<{ max: number | null }>(
        newCategoryId === null
          ? "SELECT MAX(position) AS max FROM channels WHERE category_id IS NULL"
          : "SELECT MAX(position) AS max FROM channels WHERE category_id = ?",
        newCategoryId === null ? [] : [newCategoryId],
      );
      const newPosition = (positionRows[0]?.max ?? -1) + 1;
      sets.push("category_id = ?", "position = ?");
      args.push(newCategoryId, newPosition);
      next = { ...next, category_id: newCategoryId, position: newPosition };
    }
  }

  if (Object.prototype.hasOwnProperty.call(params, "max_participants")) {
    const value = clampParticipants(params["max_participants"]);
    sets.push("max_participants = ?");
    args.push(value);
    next = { ...next, max_participants: value };
  }

  if (Object.prototype.hasOwnProperty.call(params, "bitrate_kbps")) {
    const value = clampBitrate(params["bitrate_kbps"]);
    sets.push("bitrate_kbps = ?");
    args.push(value);
    next = { ...next, bitrate_kbps: value };
  }

  if (Object.prototype.hasOwnProperty.call(params, "e2ee")) {
    const value = params["e2ee"] === true;
    sets.push("e2ee = ?");
    args.push(value ? 1 : 0);
    next = { ...next, e2ee: value };
  }

  if (Object.prototype.hasOwnProperty.call(params, "max_publishers")) {
    const value = clampPublishers(params["max_publishers"]);
    sets.push("max_publishers = ?");
    args.push(value);
    next = { ...next, max_publishers: value };
  }

  if (sets.length === 0) return next;

  args.push(id);
  await plugin.db.run(`UPDATE channels SET ${sets.join(", ")} WHERE id = ?`, args);
  plugin.events.publish("voice-channels.channel.updated", next);
  return next;
});

plugin.handle("deleteChannel", async (params, user) => {
  const allowed = await plugin.permissions.hasMinLevel(user.id, 80);
  if (!allowed) {
    throw new Error("Insufficient permissions: voice channel deletion requires admin or above");
  }
  const id = params["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("id is required");
  }
  const existing = await plugin.db.query<{ id: string }>(
    "SELECT id FROM channels WHERE id = ?",
    [id],
  );
  if (existing.length === 0) throw new Error("UNKNOWN_CHANNEL");

  await plugin.db.run("DELETE FROM channels WHERE id = ?", [id]);
  plugin.events.publish("voice-channels.channel.deleted", { id });
  return { ok: true };
});

// Mint a LiveKit join token. spec-24 §Backend SDK Surface and PR-6 §14:
// the plugin handler is the *only* authorization point in the chain. Runtime
// IPC validates shape, the SFU enforces the JWT — but who-gets-which-source
// is decided here from the authenticated `user.id`. Client-supplied
// `canPublishSources` on params is dropped (defense-in-depth, mirrors the
// existing `grants` drop).
plugin.handle("voice.join", async (params, user) => {
  const channelId = params["channelId"];
  if (typeof channelId !== "string" || channelId.length === 0) {
    throw new Error("channelId is required");
  }

  const channelRows = await plugin.db.query<ChannelRow>(
    `SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ?`,
    [channelId],
  );
  const channelRow = channelRows[0];
  if (!channelRow) throw new Error("UNKNOWN_CHANNEL");
  const channel = rowToChannel(channelRow);

  // Optional listener-only mode for muted/raid scenarios. The runtime bridge
  // also defaults missing grants to true; we forward only what the caller
  // explicitly set so the runtime owns the policy floor.
  const rawGrants = params["grants"];
  const grants =
    rawGrants && typeof rawGrants === "object" && !Array.isArray(rawGrants)
      ? (rawGrants as Record<string, unknown>)
      : undefined;
  const cleanGrants =
    grants !== undefined
      ? {
          ...(typeof grants["canPublish"] === "boolean" ? { canPublish: grants["canPublish"] } : {}),
          ...(typeof grants["canSubscribe"] === "boolean" ? { canSubscribe: grants["canSubscribe"] } : {}),
          ...(typeof grants["canPublishData"] === "boolean" ? { canPublishData: grants["canPublishData"] } : {}),
        }
      : undefined;

  // PR-6 §14 — derive `canPublishSources` from server state, never from the
  // client. The pure helper in voice-join.ts takes no params arg by
  // construction, so no client-supplied `canPublishSources` field can
  // ever reach the result. Use `check` (named permission) not `hasMinLevel`
  // (raw role level): the registered permission carries `default_level: 20`,
  // and `check` evaluates user-role-level vs that default while honoring any
  // admin overrides for the named key. `hasMinLevel(20)` would only pass for
  // users whose role level is already ≥ 20, which excludes default members.
  const hasShareScreenPermission = await plugin.permissions.check(
    user.id,
    "voice.screen_share.publish",
  );
  const canPublishSources = deriveCanPublishSources({
    channelE2ee: channel.e2ee,
    hasShareScreenPermission,
  });

  return plugin.voice.createJoinToken({
    channelId,
    userId: user.id,
    ...(cleanGrants !== undefined ? { grants: cleanGrants } : {}),
    canPublishSources,
  });
});

// PR-6 §13 — admin "Stop their share". Caller must hold
// `voice.moderation.stop_share` (default level 80, same tier as channel
// admin). LiveKit doesn't expose track-level mute today, so the safe ship
// path is full participant kick — they can rejoin with audio but the
// offending share is gone immediately. Track-level surgical mute is a
// follow-up (PR-5.5/6.5).
//
// Wired in 6b but the runtime cap `voice.moderation` is not declared on the
// manifest until 6g (the coupling rule). Calling this before 6g hits a
// CAPABILITY_DENIED error in the WS router, which is the intended floor.
plugin.handle("voice.stopShare", async (params, user) => {
  const channelId = params["channelId"];
  if (typeof channelId !== "string" || channelId.length === 0) {
    throw new Error("channelId is required");
  }
  const targetUserId = params["userId"];
  if (typeof targetUserId !== "string" || targetUserId.length === 0) {
    throw new Error("userId is required");
  }

  const allowed = await plugin.permissions.check(
    user.id,
    "voice.moderation.stop_share",
  );
  if (!allowed) {
    throw new Error(
      "Insufficient permissions: voice moderation requires level ≥ voice.moderation.stop_share",
    );
  }

  // canActOn keeps moderators from kicking peers/superiors — the standard
  // role-rank check the rest of the plugin uses for moderation.
  const outranks = await plugin.permissions.canActOn(user.id, targetUserId);
  if (!outranks) {
    throw new Error(
      "Cannot act on this user: target is at or above your role level",
    );
  }

  const channelRows = await plugin.db.query<{ id: string }>(
    "SELECT id FROM channels WHERE id = ?",
    [channelId],
  );
  if (channelRows.length === 0) throw new Error("UNKNOWN_CHANNEL");

  const rawReason = params["reason"];
  const reason =
    typeof rawReason === "string" && rawReason.length > 0 ? rawReason : undefined;

  return plugin.voice.removeParticipant({
    channelId,
    userId: targetUserId,
    ...(reason !== undefined ? { reason } : {}),
  });
});

// ---------------------------------------------------------------------------
// Occupancy tracker — in-memory map of `channelId → userId → presence`. Fed
// by the LiveKit webhook fanout below, surfaced to clients in two places:
//
//   1. Initial sync: `sidebar.items` attaches a `participants` array per
//      channel so a freshly-connected client sees the current state without
//      a separate request. Without this, anyone joining mid-session sees an
//      empty channel until the next join/leave event.
//   2. Live updates: `voice.participant.joined/left` broadcasts carry the
//      enriched presence row (display_name + avatar_url) so the shell can
//      render avatars without a second round-trip per event.
//
// Lost on runtime restart — but the LiveKit container restarts with the
// runtime image, which kicks all participants, so the cleared state matches
// reality. If they ever decouple we'll need a startup ListParticipants seed.
// ---------------------------------------------------------------------------

interface PresenceRow {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

const occupancy = new Map<string, Map<string, PresenceRow>>();

function rememberPresence(channelId: string, presence: PresenceRow): void {
  let channel = occupancy.get(channelId);
  if (!channel) {
    channel = new Map();
    occupancy.set(channelId, channel);
  }
  channel.set(presence.userId, presence);
}

function forgetPresence(channelId: string, userId: string): void {
  const channel = occupancy.get(channelId);
  if (!channel) return;
  channel.delete(userId);
  if (channel.size === 0) occupancy.delete(channelId);
}

function listPresence(channelId: string): PresenceRow[] {
  const channel = occupancy.get(channelId);
  if (!channel) return [];
  return Array.from(channel.values());
}

function presenceFromCoreUser(userId: string, user: { display_name: string; avatar_url: string } | null): PresenceRow {
  // Empty avatar_url collapses to null on the wire — clients render initials
  // instead of issuing a doomed GET. Display name falls back to a short id
  // suffix only when Core has nothing (deleted user, never-seen identity).
  return {
    userId,
    displayName: user?.display_name ?? userId.slice(0, 8),
    avatarUrl: user && user.avatar_url.length > 0 ? user.avatar_url : null,
  };
}

plugin.handle("sidebar.items", async (_params, user) => {
  const rows = await plugin.db.query<ChannelRow>(
    `SELECT ${CHANNEL_COLUMNS} FROM channels ORDER BY position ASC, created_at ASC`,
  );
  const isAdmin = await plugin.permissions.hasMinLevel(user.id, 80);

  const items = rows.map((row) => {
    const channel = rowToChannel(row);
    const item: {
      id: string;
      label: string;
      icon: string;
      panelType: "plugin";
      slug: string;
      section: string;
      group_id?: string | null;
      adminActions?: Array<{ id: string; label: string; icon: string }>;
      participants?: PresenceRow[];
    } = {
      id: channel.id,
      label: channel.name,
      icon: "volume2",
      panelType: "plugin",
      slug: "voice-channels",
      section: "Voice",
      group_id: channel.category_id,
    };

    const presence = listPresence(channel.id);
    if (presence.length > 0) item.participants = presence;

    if (isAdmin) {
      // Per-item actions only — create-channel lives at section scope below
      // so the "+" stays visible on a fresh server with zero voice channels.
      item.adminActions = [
        { id: "edit-channel", label: "Edit", icon: "pencil" },
        { id: "delete-channel", label: "Delete", icon: "trash" },
      ];
    }

    return item;
  });

  if (isAdmin) {
    return {
      items,
      adminActions: [{ id: "create-channel", label: "New Voice Channel", icon: "plus" }],
    };
  }
  return { items };
});

// ---------------------------------------------------------------------------
// Permission registration + cascade subscriptions
//
// Registered after all handlers so an inbound IPC during init never lands on
// an unregistered action.
// ---------------------------------------------------------------------------

await plugin.permissions.register("voice.channels.create", {
  description: "Create, edit, and delete voice channels",
  default_level: 80,
});

// PR-6 §1 — per-user screen-share publish gate. Authoritative for the
// `voice.join` source derivation above; the SFU then enforces the granted
// `canPublishSources` claim at publish time. Default 20 (member) sits above
// fresh-joiner level so a public-server visitor can't drive-by-spam screen
// content; admins can lower per-server for lobby-style "anyone shares".
await plugin.permissions.register("voice.screen_share.publish", {
  description:
    "Publish a screen-share track in a voice channel (mic publishing is granted to all members regardless)",
  default_level: SCREEN_SHARE_PUBLISH_DEFAULT_LEVEL,
});

// PR-6 §13 — admin "Stop their share" gate. LiveKit has no per-track mute
// API today, so the moderation primitive is participant-kick. Default 80
// matches `voice.channels.create` — same tier as channel administrators.
await plugin.permissions.register("voice.moderation.stop_share", {
  description: "Force-stop another user's screen share (kicks them from the room)",
  default_level: MODERATION_STOP_SHARE_DEFAULT_LEVEL,
});

// Soft-FK cleanup: when Core deletes a category, NULL out matching channels
// so they fall back to the Uncategorized bucket instead of disappearing.
await plugin.events.subscribe("core.category.deleted", async (event) => {
  const payload = event.payload as Record<string, unknown>;
  const categoryId = payload["id"];
  if (typeof categoryId !== "string" || categoryId.length === 0) return;
  await plugin.db.run(
    "UPDATE channels SET category_id = NULL WHERE category_id = ?",
    [categoryId],
  );
});

// Re-broadcast runtime voice events to subscribed clients so the frontend
// can show occupancy, mute state, and disconnect reasons without each client
// resubscribing on the bus directly.
async function fanoutToAll(event: string, payload: unknown): Promise<void> {
  await plugin.broadcast.toAll(event, payload);
}

function asEventRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

await plugin.events.subscribe("runtime.voice.participant.joined", async (event) => {
  const payload = asEventRecord(event.payload);
  if (!payload) return;
  const channelId = payload["channelId"];
  const userId = payload["userId"];
  if (typeof channelId !== "string" || typeof userId !== "string") return;
  const coreUser = await plugin.core.getUser(userId);
  const presence = presenceFromCoreUser(userId, coreUser);
  rememberPresence(channelId, presence);
  // Forward the canonical runtime payload alongside the enriched presence
  // row so legacy consumers (no `participant` field) keep working while the
  // shell sidebar can pick up presence directly.
  await fanoutToAll("voice.participant.joined", { ...payload, participant: presence });
});
await plugin.events.subscribe("runtime.voice.participant.left", async (event) => {
  const payload = asEventRecord(event.payload);
  if (!payload) return;
  const channelId = payload["channelId"];
  const userId = payload["userId"];
  if (typeof channelId !== "string" || typeof userId !== "string") return;
  forgetPresence(channelId, userId);
  await fanoutToAll("voice.participant.left", payload);
});
await plugin.events.subscribe("runtime.voice.room.created", async (event) => {
  await fanoutToAll("voice.room.created", event.payload);
});
await plugin.events.subscribe("runtime.voice.room.destroyed", async (event) => {
  // Channel emptied — clear cached presence so the next sidebar.items call
  // doesn't return ghosts. LiveKit fires room_finished on the last leave,
  // so individual participant.left events have already cleared most rows;
  // this is a safety net for edge cases (forced room destroy, race).
  const payload = asEventRecord(event.payload);
  const channelId = payload?.["channelId"];
  if (typeof channelId === "string") occupancy.delete(channelId);
  await fanoutToAll("voice.room.destroyed", event.payload);
});
await plugin.events.subscribe("runtime.voice.health.changed", async (event) => {
  await fanoutToAll("voice.health.changed", event.payload);
});

// spec-24 Amendment A — external reachability is the silent-failure surface
// where signaling reaches the runtime through Cloudflare Tunnel but media
// never flows because the owner's router doesn't forward TCP 7881 /
// UDP 3478 (TURN/STUN probe target — Amendment C; the MUX media port on
// 50000 is recommended but not probed because pion ICE drops cold STUN
// at the MUX socket). The runtime publishes `runtime.voice.reachability.changed`
// whenever the public projection's `status` flips. We rebroadcast to all
// clients on this server so the shell can dim broken voice channels and
// owners can pop the diagnostics modal — but `wanIp` is owner-only and is
// stripped via `redactReachability` before going on the wire. Owners read
// the unredacted form directly from /admin/api/voice/state.
await plugin.events.subscribe("runtime.voice.reachability.changed", async (event) => {
  const payload = asEventRecord(event.payload);
  if (!payload) return;
  const current = redactReachability(payload["current"]);
  if (!current) return;
  await fanoutToAll("voice.reachability.changed", { current });
});
