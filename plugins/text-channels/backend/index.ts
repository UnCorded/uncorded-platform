import { createPlugin } from "@uncorded/plugin-sdk";
import type { PresenceEntry } from "@uncorded/plugin-sdk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Settings cache — refreshed on boot from `_config` and re-synced on every
// `core.plugin.config_changed` delivery. Defaults below match the manifest
// declarations; the runtime always returns the manifest default for unset
// keys so this is just safety net for the brief window before refreshSettings
// completes on first call.
//
// `maxMessageLength === 0` is the manifest's "Not Guarded" stop — when set,
// the length cap is skipped entirely.
let maxMessageLength = 5000;
let allowEdits = true;
let attachmentsEnabled = true;
let attachmentsMaxBytes = 5_368_709_120; // 5 GiB — must mirror manifest default
let attachmentsMaxPerMessage = 10;

const MAX_QUERY_LIMIT = 100;

// Orphan GC: how often to sweep, and how long a file is allowed to sit
// unreferenced before we delete it. The grace window covers the gap between
// a successful POST /upload and the eventual sendMessage that references the
// filename (e.g. user dragged a 500 MB file but never hit Send).
const ORPHAN_GC_INTERVAL_MS = 60 * 60 * 1000; // hourly
const ORPHAN_GRACE_MS = 60 * 60 * 1000;       // 1 hour

// Typing TTL — frontend re-pings every 2s while composing; an entry is
// considered "stale" once typing_until has passed. 5s gives the frontend
// margin for network jitter.
const TYPING_TTL_MS = 5000;

// Hard cap from sdk.broadcast.toUsers. If a scope has more viewers than this,
// we truncate + emit a structured warning (spec-6: failures are loud).
const MAX_BROADCAST_AUDIENCE = 100;

// Explicit column list — avoids leaking migration-added fields through SELECT *
// before the wire contract catches up.
const MESSAGE_COLUMNS =
  "id, channel_id, author_id, content, created_at, edited_at, parent_message_id, reply_count, last_reply_at, attachments";

// Per-attachment-metadata caps. These bound what we'll accept from the
// frontend's optional layout hints; the file itself was already vetted by
// the runtime's streaming upload (size, MIME sniff, atomic rename).
const ATTACHMENT_MAX_NAME_LEN = 255;
const ATTACHMENT_MAX_MIME_LEN = 128;
const ATTACHMENT_MAX_DIMENSION = 100000;   // pixels (defensive)
const ATTACHMENT_MAX_DURATION_S = 24 * 60 * 60; // 24h media

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Channel {
  id: string;
  name: string;
  topic: string;
  created_at: number;
  category_id: string | null;
  position: number;
}

const CHANNEL_COLUMNS = "id, name, topic, created_at, category_id, position";

async function isValidCategoryId(id: string): Promise<boolean> {
  const categories = await plugin.core.listCategories();
  return categories.some((c) => c.id === id);
}

interface Message {
  id: string;
  channel_id: string;
  author_id: string;
  content: string;
  created_at: number;
  edited_at: number | null;
  parent_message_id: string | null;
  reply_count: number;
  last_reply_at: number | null;
  /** Raw JSON-serialized StoredAttachment[] from the DB. NULL when none. */
  attachments: string | null;
}

/** What lives in messages.attachments (JSON) — never includes a signed URL. */
interface StoredAttachment {
  filename: string;
  original_name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
}

/** What ships over the wire to clients — URLs minted fresh per read. */
interface WireAttachment extends StoredAttachment {
  /** Path-only signed URL. Client prepends server origin at render. */
  url: string;
}

interface EnrichedMessage extends Omit<Message, "attachments"> {
  author_name: string;
  author_avatar: string;
  attachments: WireAttachment[];
}

// ---------------------------------------------------------------------------
// Plugin init
// ---------------------------------------------------------------------------

const plugin = createPlugin();

async function refreshSettings(): Promise<void> {
  try {
    const values = await plugin.settings.getAll();
    const len = values["max_message_length"];
    // 0 is a legal stop ("Not Guarded" — disables the cap entirely).
    if (typeof len === "number" && Number.isFinite(len) && len >= 0) {
      maxMessageLength = len;
    }
    const edits = values["allow_edits"];
    if (typeof edits === "boolean") {
      allowEdits = edits;
    }
    const enabled = values["attachments_enabled"];
    if (typeof enabled === "boolean") {
      attachmentsEnabled = enabled;
    }
    const maxBytes = values["attachments_max_bytes"];
    if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0) {
      attachmentsMaxBytes = maxBytes;
    }
    const maxPer = values["attachments_max_per_message"];
    if (typeof maxPer === "number" && Number.isFinite(maxPer) && maxPer > 0) {
      attachmentsMaxPerMessage = Math.floor(maxPer);
    }
  } catch {
    // Settings unavailable (e.g. early-boot race): keep current values.
  }
}

void refreshSettings();
plugin.settings.onChange(() => {
  void refreshSettings().then(() => {
    // Push the new attachment limits to every connected frontend so the
    // tray pre-flight cap updates without a reload. The frontend's hardcoded
    // defaults are only a fallback for the first paint before init fetches.
    plugin.events.publish("text-channels.attachments.settings_updated", {
      enabled: attachmentsEnabled,
      maxBytes: attachmentsMaxBytes,
      maxPerMessage: attachmentsMaxPerMessage,
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch author profiles from Core Module and return an id→profile map. */
async function fetchAuthorMap(userIds: string[]): Promise<Map<string, { display_name: string; avatar_url: string }>> {
  if (userIds.length === 0) return new Map();
  const unique = [...new Set(userIds)];
  const users = await plugin.core.getUsers(unique);
  const map = new Map<string, { display_name: string; avatar_url: string }>();
  for (const user of users) {
    map.set(user.id, { display_name: user.display_name, avatar_url: user.avatar_url });
  }
  return map;
}

/**
 * Safely parse the JSON-serialized attachments column. Returns [] for
 * NULL, malformed JSON, or any record that fails strict shape validation.
 * Storage trust boundary: rows were inserted by sendMessage/editMessage
 * after validation, but a future migration could change shape — be defensive.
 */
function parseStoredAttachments(raw: string | null): StoredAttachment[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: StoredAttachment[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const filename = e["filename"];
    const originalName = e["original_name"];
    const mime = e["mime"];
    const size = e["size"];
    if (typeof filename !== "string" || filename.length === 0) continue;
    if (typeof originalName !== "string") continue;
    if (typeof mime !== "string" || mime.length === 0) continue;
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) continue;
    const rec: StoredAttachment = { filename, original_name: originalName, mime, size };
    const w = e["width"];
    const h = e["height"];
    const d = e["duration"];
    if (typeof w === "number" && Number.isFinite(w) && w > 0) rec.width = w;
    if (typeof h === "number" && Number.isFinite(h) && h > 0) rec.height = h;
    if (typeof d === "number" && Number.isFinite(d) && d > 0) rec.duration = d;
    out.push(rec);
  }
  return out;
}

/**
 * Mint fresh per-user signed URLs for stored attachments. We never persist
 * URLs — the runtime's signing secret rotates on boot, and tunnel hostnames
 * may flip, so every read regenerates.
 *
 * Per-attachment failures (e.g. signUrl rejected by runtime for an invalid
 * filename) are dropped from the wire result rather than poisoning the whole
 * message. The message text + author render normally; the missing attachment
 * surfaces as a missing thumbnail, which is the least-destructive UX.
 */
async function signAttachments(
  stored: StoredAttachment[],
  userId: string,
): Promise<WireAttachment[]> {
  if (stored.length === 0) return [];
  const results = await Promise.all(stored.map(async (a) => {
    try {
      const signed = await plugin.files.signUrl(a.filename, userId);
      const wire: WireAttachment = {
        filename: a.filename,
        original_name: a.original_name,
        mime: a.mime,
        size: a.size,
        url: signed.url,
      };
      if (a.width !== undefined) wire.width = a.width;
      if (a.height !== undefined) wire.height = a.height;
      if (a.duration !== undefined) wire.duration = a.duration;
      return wire;
    } catch (err) {
      logWarn("attachment.sign_failed", {
        filename: a.filename,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }));
  return results.filter((r): r is WireAttachment => r !== null);
}

/**
 * Validate an attachments-array param from a sendMessage / editMessage call.
 * Each entry must reference a filename that the runtime has on disk for this
 * plugin (verified via plugin.files.stat). Server-recorded size wins over the
 * client's claim. Visual hints (width/height/duration) are accepted as-is
 * within bounds — server has no way to extract them and a bad hint only
 * affects layout, not access control.
 *
 * Throws structured Error("ATTACHMENT_…") for the request handler to surface
 * to the caller verbatim.
 */
async function validateAttachments(raw: unknown): Promise<StoredAttachment[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("ATTACHMENTS_INVALID");
  }
  if (raw.length === 0) return [];
  if (!attachmentsEnabled) {
    throw new Error("ATTACHMENTS_DISABLED");
  }
  if (raw.length > attachmentsMaxPerMessage) {
    throw new Error("ATTACHMENTS_TOO_MANY");
  }

  const seen = new Set<string>();
  const out: StoredAttachment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      throw new Error("ATTACHMENT_INVALID");
    }
    const e = entry as Record<string, unknown>;
    const filename = e["filename"];
    if (typeof filename !== "string" || filename.length === 0 || filename.length > ATTACHMENT_MAX_NAME_LEN) {
      throw new Error("ATTACHMENT_INVALID_FILENAME");
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) {
      throw new Error("ATTACHMENT_INVALID_FILENAME");
    }
    if (seen.has(filename)) {
      throw new Error("ATTACHMENT_DUPLICATE");
    }
    seen.add(filename);

    const originalNameRaw = e["original_name"];
    const originalName = typeof originalNameRaw === "string"
      ? originalNameRaw.slice(0, ATTACHMENT_MAX_NAME_LEN)
      : "";

    const mimeRaw = e["mime"];
    const mime = typeof mimeRaw === "string" && mimeRaw.length > 0 && mimeRaw.length <= ATTACHMENT_MAX_MIME_LEN
      ? mimeRaw
      : "application/octet-stream";

    // Authoritative size check via runtime stat.
    const stat = await plugin.files.stat(filename);
    if (!stat.exists) {
      throw new Error("ATTACHMENT_NOT_FOUND");
    }
    if (stat.size > attachmentsMaxBytes) {
      throw new Error("ATTACHMENT_TOO_LARGE");
    }

    const rec: StoredAttachment = {
      filename,
      original_name: originalName,
      mime,
      size: stat.size,
    };
    const w = e["width"];
    const h = e["height"];
    const d = e["duration"];
    if (typeof w === "number" && Number.isFinite(w) && w > 0 && w <= ATTACHMENT_MAX_DIMENSION) rec.width = Math.floor(w);
    if (typeof h === "number" && Number.isFinite(h) && h > 0 && h <= ATTACHMENT_MAX_DIMENSION) rec.height = Math.floor(h);
    if (typeof d === "number" && Number.isFinite(d) && d > 0 && d <= ATTACHMENT_MAX_DURATION_S) rec.duration = d;
    out.push(rec);
  }
  return out;
}

function enrichMessage(
  msg: Message,
  authorMap: Map<string, { display_name: string; avatar_url: string }>,
  attachments: WireAttachment[],
): EnrichedMessage {
  const author = authorMap.get(msg.author_id);
  const {
    id, channel_id, author_id, content, created_at, edited_at,
    parent_message_id, reply_count, last_reply_at,
  } = msg;
  return {
    id, channel_id, author_id, content, created_at, edited_at,
    parent_message_id, reply_count, last_reply_at,
    author_name: author?.display_name ?? msg.author_id.slice(0, 8),
    author_avatar: author?.avatar_url ?? "",
    attachments,
  };
}

async function enrichMessages(messages: Message[], userId: string): Promise<EnrichedMessage[]> {
  const memberMap = await fetchAuthorMap(messages.map((m) => m.author_id));
  return Promise.all(messages.map(async (m) => {
    const stored = parseStoredAttachments(m.attachments);
    const wire = await signAttachments(stored, userId);
    return enrichMessage(m, memberMap, wire);
  }));
}

// ---------------------------------------------------------------------------
// Presence scopes — scope strings are unprefixed here; the SDK auto-prefixes
// with this plugin's slug ("text-channels.").
// ---------------------------------------------------------------------------

function channelTypingScope(channelId: string): string {
  return `channel.${channelId}.typing`;
}
function channelViewersScope(channelId: string): string {
  return `channel.${channelId}.viewers`;
}
function threadTypingScope(messageId: string): string {
  return `thread.${messageId}.typing`;
}
function threadViewersScope(messageId: string): string {
  return `thread.${messageId}.viewers`;
}

// Runtime evicts plugin-owned presence on plugin unload (spec-23,
// reason: "plugin_unloaded"). No plugin-side shutdown cleanup is needed.
const watchUnsubs = new Map<string, () => Promise<void>>();

function logWarn(event: string, extra: Record<string, unknown>): void {
  // Structured warning — runtime's stdio log collector adds timestamps.
  console.error(JSON.stringify({ level: "warn", plugin: "text-channels", event, ...extra }));
}

/** Filter typing entries that haven't expired and enrich with display_name so
 * frontends can render "Alice is typing…" without a separate profile fetch. */
async function liveTypingUsers(
  entries: PresenceEntry[],
): Promise<Array<{ user_id: string; display_name: string; typing_until: number }>> {
  const now = Date.now();
  const live: Array<{ user_id: string; typing_until: number }> = [];
  for (const e of entries) {
    const until = e.meta["typing_until"];
    if (typeof until === "number" && until > now) {
      live.push({ user_id: e.user_id, typing_until: until });
    }
  }
  if (live.length === 0) return [];
  const map = await fetchAuthorMap(live.map((u) => u.user_id));
  return live.map((u) => ({
    user_id: u.user_id,
    display_name: map.get(u.user_id)?.display_name ?? u.user_id.slice(0, 8),
    typing_until: u.typing_until,
  }));
}

/** Unique user_ids from a scope's entries, capped + warned past MAX_BROADCAST_AUDIENCE. */
async function audienceForScope(viewersScope: string): Promise<string[]> {
  const entries = await plugin.presence.list(viewersScope);
  const unique = [...new Set(entries.map((e) => e.user_id))];
  if (unique.length > MAX_BROADCAST_AUDIENCE) {
    logWarn("broadcast.audience_truncated", {
      scope: viewersScope,
      actual: unique.length,
      cap: MAX_BROADCAST_AUDIENCE,
    });
    return unique.slice(0, MAX_BROADCAST_AUDIENCE);
  }
  return unique;
}

// Broadcast event names are passed unprefixed; the runtime prepends the
// plugin slug (→ wire topic "text-channels.typing.updated"). The `scope`
// value in payloads IS fully qualified (with plugin slug) to mirror the
// presence entries the SDK returns.
const SCOPE_PREFIX = "text-channels.";

function qualifiedScope(unprefixed: string): string {
  return `${SCOPE_PREFIX}${unprefixed}`;
}

async function broadcastTypingTo(viewersScope: string, typingScope: string, entries: PresenceEntry[]): Promise<void> {
  const users = await liveTypingUsers(entries);
  const audience = await audienceForScope(viewersScope);
  if (audience.length === 0) return;
  await plugin.broadcast.toUsers(audience, "typing.updated", {
    scope: qualifiedScope(typingScope),
    users,
  });
}

async function broadcastViewersTo(viewersScope: string, entries: PresenceEntry[]): Promise<void> {
  const users = [...new Set(entries.map((e) => e.user_id))];
  const audience = users.length > MAX_BROADCAST_AUDIENCE ? users.slice(0, MAX_BROADCAST_AUDIENCE) : users;
  if (users.length > MAX_BROADCAST_AUDIENCE) {
    logWarn("broadcast.audience_truncated", {
      scope: viewersScope,
      actual: users.length,
      cap: MAX_BROADCAST_AUDIENCE,
    });
  }
  if (audience.length === 0) return;
  await plugin.broadcast.toUsers(audience, "viewers.updated", {
    scope: qualifiedScope(viewersScope),
    users: audience.map((user_id) => ({ user_id })),
    count: users.length,
  });
}

async function ensureWatcher(scope: string, callback: (entries: PresenceEntry[]) => void | Promise<void>): Promise<void> {
  if (watchUnsubs.has(scope)) return;
  const unsub = await plugin.presence.watch(scope, callback, { coalesceMs: 50 });
  watchUnsubs.set(scope, unsub);
}

async function registerChannelWatchers(channelId: string): Promise<void> {
  const typingScope = channelTypingScope(channelId);
  const viewersScope = channelViewersScope(channelId);
  await ensureWatcher(typingScope, (entries) => {
    void broadcastTypingTo(viewersScope, typingScope, entries);
  });
  await ensureWatcher(viewersScope, (entries) => {
    void broadcastViewersTo(viewersScope, entries);
  });
}

async function registerThreadWatchersIfNeeded(messageId: string): Promise<void> {
  // Monotonic registration by design — watchUnsubs never shrinks. Bounded by
  // distinct (real) thread message_ids ever touched × 2, which the call-site
  // existence check in setTyping/setViewingThread keeps finite. A future
  // reference-counted unregister (tear down when both typing and viewers
  // scopes are empty) would be a pure optimization; not needed for v1.
  const typingScope = threadTypingScope(messageId);
  const viewersScope = threadViewersScope(messageId);
  await ensureWatcher(typingScope, (entries) => {
    void broadcastTypingTo(viewersScope, typingScope, entries);
  });
  await ensureWatcher(viewersScope, (entries) => {
    void broadcastViewersTo(viewersScope, entries);
  });
}

// ---------------------------------------------------------------------------
// Handlers — registered synchronously before any async IPC calls so they
// are available as soon as the runtime starts routing requests.
// ---------------------------------------------------------------------------

plugin.handle("getChannels", async (_params, _user) => {
  return plugin.db.query<Channel>(
    `SELECT ${CHANNEL_COLUMNS} FROM channels ORDER BY position ASC, created_at ASC`,
  );
});

plugin.handle("getAttachmentSettings", async (_params, _user) => {
  return {
    enabled: attachmentsEnabled,
    maxBytes: attachmentsMaxBytes,
    maxPerMessage: attachmentsMaxPerMessage,
  };
});

plugin.handle("createChannel", async (params, user) => {
  const allowed = await plugin.permissions.hasMinLevel(user.id, 60);
  if (!allowed) {
    throw new Error("Insufficient permissions: requires moderator or above");
  }

  const name = params["name"];
  const topic = params["topic"];
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("name is required and must be a non-empty string");
  }
  const topicStr = typeof topic === "string" ? topic : "";

  const rawCategoryId = params["category_id"];
  const categoryId = typeof rawCategoryId === "string" && rawCategoryId.length > 0
    ? rawCategoryId
    : null;
  if (categoryId !== null && !(await isValidCategoryId(categoryId))) {
    throw new Error("UNKNOWN_CATEGORY");
  }

  // Position: append at the end of the category bucket (or uncategorized).
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
    "INSERT INTO channels (id, name, topic, created_at, category_id, position) VALUES (?, ?, ?, ?, ?, ?)",
    [id, name, topicStr, now, categoryId, position],
  );

  const channel: Channel = {
    id,
    name,
    topic: topicStr,
    created_at: now,
    category_id: categoryId,
    position,
  };
  // Register typing/viewers watchers BEFORE publishing the event so a client
  // that drops this channel into a panel and starts typing immediately isn't
  // racing the event-bus subscriber below. ensureWatcher is idempotent, so
  // the subscriber is still safe as a backup for channels created by any
  // future path that bypasses this handler.
  await registerChannelWatchers(id);
  plugin.events.publish("text-channels.channel.created", channel);
  return channel;
});

plugin.handle("updateChannel", async (params, user) => {
  const allowed = await plugin.permissions.hasMinLevel(user.id, 60);
  if (!allowed) {
    throw new Error("Insufficient permissions: requires moderator or above");
  }

  const id = params["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("id is required and must be a non-empty string");
  }

  const existing = await plugin.db.query<Channel>(
    `SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ?`,
    [id],
  );
  const current = existing[0];
  if (!current) {
    throw new Error("UNKNOWN_CHANNEL");
  }

  const sets: string[] = [];
  const args: Array<string | number | null> = [];
  let nextName = current.name;
  let nextTopic = current.topic;
  let nextCategoryId = current.category_id;
  let nextPosition = current.position;

  if (Object.prototype.hasOwnProperty.call(params, "name")) {
    const name = params["name"];
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("name must be a non-empty string");
    }
    sets.push("name = ?");
    args.push(name);
    nextName = name;
  }

  if (Object.prototype.hasOwnProperty.call(params, "topic")) {
    const topic = params["topic"];
    if (typeof topic !== "string") {
      throw new Error("topic must be a string");
    }
    sets.push("topic = ?");
    args.push(topic);
    nextTopic = topic;
  }

  // category_id: explicit null (or empty string) clears it; a non-empty string
  // moves the channel to that category. The field must be present in params for
  // a category change — undefined leaves it untouched.
  if (Object.prototype.hasOwnProperty.call(params, "category_id")) {
    const raw = params["category_id"];
    const newCategoryId =
      typeof raw === "string" && raw.length > 0 ? raw : null;
    if (newCategoryId !== null && !(await isValidCategoryId(newCategoryId))) {
      throw new Error("UNKNOWN_CATEGORY");
    }
    if (newCategoryId !== current.category_id) {
      // Append to end of destination bucket.
      const positionRows = await plugin.db.query<{ max: number | null }>(
        newCategoryId === null
          ? "SELECT MAX(position) AS max FROM channels WHERE category_id IS NULL"
          : "SELECT MAX(position) AS max FROM channels WHERE category_id = ?",
        newCategoryId === null ? [] : [newCategoryId],
      );
      nextPosition = (positionRows[0]?.max ?? -1) + 1;
      sets.push("category_id = ?", "position = ?");
      args.push(newCategoryId, nextPosition);
      nextCategoryId = newCategoryId;
    }
  }

  if (sets.length === 0) {
    return current;
  }

  args.push(id);
  await plugin.db.run(`UPDATE channels SET ${sets.join(", ")} WHERE id = ?`, args);

  const updated: Channel = {
    id,
    name: nextName,
    topic: nextTopic,
    created_at: current.created_at,
    category_id: nextCategoryId,
    position: nextPosition,
  };
  plugin.events.publish("text-channels.channel.updated", updated);
  return updated;
});

plugin.handle("deleteChannel", async (params, user) => {
  const allowed = await plugin.permissions.hasMinLevel(user.id, 60);
  if (!allowed) {
    throw new Error("Insufficient permissions: requires moderator or above");
  }

  const id = params["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("id is required and must be a non-empty string");
  }

  const existing = await plugin.db.query<{ id: string }>(
    "SELECT id FROM channels WHERE id = ?",
    [id],
  );
  if (existing.length === 0) {
    throw new Error("UNKNOWN_CHANNEL");
  }

  // Drop messages before the channel row so the messages.channel_id
  // REFERENCES channels(id) FK never blocks the delete (SQLite enforces it
  // iff PRAGMA foreign_keys=ON; ordering this way is safe either way). One
  // batch keeps the two writes atomic.
  await plugin.db.batch([
    { sql: "DELETE FROM messages WHERE channel_id = ?", params: [id] },
    { sql: "DELETE FROM channels WHERE id = ?", params: [id] },
  ]);

  // Tear down the typing/viewers presence watchers we registered for this
  // channel so watchUnsubs doesn't grow unbounded as channels come and go.
  for (const scope of [channelTypingScope(id), channelViewersScope(id)]) {
    const unsub = watchUnsubs.get(scope);
    if (unsub) {
      try { await unsub(); } catch { /* presence registry already cleared */ }
      watchUnsubs.delete(scope);
    }
  }

  plugin.events.publish("text-channels.channel.deleted", { id });
  return { ok: true };
});

plugin.handle("getMessages", async (params, user) => {
  const channelId = params["channel_id"];
  if (typeof channelId !== "string") {
    throw new Error("channel_id is required");
  }
  const rawLimit = typeof params["limit"] === "number" ? params["limit"] : 50;
  const limit = Math.min(Math.max(1, rawLimit), MAX_QUERY_LIMIT);
  const messages = await plugin.db.query<Message>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel_id = ? AND parent_message_id IS NULL ORDER BY created_at DESC LIMIT ?`,
    [channelId, limit],
  );
  return enrichMessages(messages, user.id);
});

plugin.handle("getThreadReplies", async (params, user) => {
  const messageId = params["message_id"];
  if (typeof messageId !== "string") {
    throw new Error("message_id is required");
  }
  const rawLimit = typeof params["limit"] === "number" ? params["limit"] : 50;
  const limit = Math.min(Math.max(1, rawLimit), MAX_QUERY_LIMIT);
  const rawBefore = params["before_created_at"];
  const before = typeof rawBefore === "number" ? rawBefore : null;

  const rows = before === null
    ? await plugin.db.query<Message>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE parent_message_id = ? ORDER BY created_at ASC LIMIT ?`,
        [messageId, limit],
      )
    : await plugin.db.query<Message>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE parent_message_id = ? AND created_at < ? ORDER BY created_at ASC LIMIT ?`,
        [messageId, before, limit],
      );
  return enrichMessages(rows, user.id);
});

plugin.handle("sendMessage", async (params, user) => {
  const allowed = await plugin.permissions.check(user.id, "text-channels.post");
  if (!allowed) {
    throw new Error("Permission denied: text-channels.post");
  }

  const channelId = params["channel_id"];
  const content = params["content"];
  if (typeof channelId !== "string") {
    throw new Error("channel_id is required");
  }
  if (typeof content !== "string") {
    throw new Error("content is required and must be a string");
  }
  if (maxMessageLength > 0 && content.length > maxMessageLength) {
    throw new Error("MESSAGE_TOO_LONG");
  }

  // Attachments are validated against the runtime's on-disk view before any
  // DB write — guarantees we never persist a row referencing a missing file.
  const attachments = await validateAttachments(params["attachments"]);

  // A message must have content OR attachments — empty-content posts are
  // legal when they carry at least one file. Pure empty messages are spam.
  if (content.length === 0 && attachments.length === 0) {
    throw new Error("EMPTY_MESSAGE");
  }

  const rawParent = params["parent_message_id"];
  const parentId = typeof rawParent === "string" ? rawParent : null;

  const id = crypto.randomUUID();
  const now = Date.now();
  // Storage shape: empty attachments persist as NULL (NOT "[]") so SELECT
  // filters can use `attachments IS NOT NULL` cheaply.
  const attachmentsJson = attachments.length > 0 ? JSON.stringify(attachments) : null;

  if (parentId === null) {
    await plugin.db.run(
      `INSERT INTO messages (id, channel_id, author_id, content, created_at, parent_message_id, reply_count, last_reply_at, attachments)
       VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, ?)`,
      [id, channelId, user.id, content, now, attachmentsJson],
    );
  } else {
    // Reply path — validate parent is a root in the same channel, then atomically
    // INSERT the reply and bump parent counters.
    const parentRows = await plugin.db.query<Message>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`,
      [parentId],
    );
    const parent = parentRows[0];
    if (!parent || parent.channel_id !== channelId || parent.parent_message_id !== null) {
      throw new Error("INVALID_PARENT");
    }

    await plugin.db.batch([
      {
        sql: `INSERT INTO messages (id, channel_id, author_id, content, created_at, parent_message_id, reply_count, last_reply_at, attachments)
              VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
        params: [id, channelId, user.id, content, now, parentId, attachmentsJson],
      },
      {
        sql: "UPDATE messages SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?",
        params: [now, parentId],
      },
    ]);
  }

  const message: Message = {
    id,
    channel_id: channelId,
    author_id: user.id,
    content,
    created_at: now,
    edited_at: null,
    parent_message_id: parentId,
    reply_count: 0,
    last_reply_at: null,
    attachments: attachmentsJson,
  };
  const memberMap = await fetchAuthorMap([user.id]);
  const wireAttachments = await signAttachments(attachments, user.id);
  const enriched = enrichMessage(message, memberMap, wireAttachments);
  // URLs in the published event are signed against the author's user_id —
  // signature verification is identity-blind (the URL works for any viewer
  // until exp), so per-viewer re-signing isn't needed here. Audit logs
  // tie back to the author, which matches "who emitted this URL".
  plugin.events.publish("text-channels.message.created", enriched);
  return enriched;
});

plugin.handle("editMessage", async (params, user) => {
  if (!allowEdits) {
    throw new Error("EDITS_DISABLED");
  }

  const allowed = await plugin.permissions.check(user.id, "text-channels.post");
  if (!allowed) {
    throw new Error("Permission denied: text-channels.post");
  }

  const messageId = params["message_id"];
  const content = params["content"];
  if (typeof messageId !== "string") {
    throw new Error("message_id is required");
  }
  if (typeof content !== "string") {
    throw new Error("content is required and must be a string");
  }
  if (maxMessageLength > 0 && content.length > maxMessageLength) {
    throw new Error("MESSAGE_TOO_LONG");
  }

  const rows = await plugin.db.query<Message>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`,
    [messageId],
  );
  const existing = rows[0];
  if (!existing) {
    throw new Error("Message not found");
  }
  if (existing.author_id !== user.id) {
    throw new Error("Can only edit your own messages");
  }

  // Edits are content-only: attachments are locked at send time. Empty
  // content is legal iff the existing row still has attachments — matches
  // sendMessage's "content OR attachments" rule on edit too.
  if (content.length === 0 && !existing.attachments) {
    throw new Error("EMPTY_MESSAGE");
  }

  const now = Date.now();
  await plugin.db.run(
    "UPDATE messages SET content = ?, edited_at = ? WHERE id = ?",
    [content, now, messageId],
  );

  const updated: Message = { ...existing, content, edited_at: now };
  const stored = parseStoredAttachments(updated.attachments);
  const memberMap = await fetchAuthorMap([updated.author_id]);
  const wireAttachments = await signAttachments(stored, user.id);
  const enriched = enrichMessage(updated, memberMap, wireAttachments);
  plugin.events.publish("text-channels.message.edited", enriched);
  return enriched;
});

plugin.handle("deleteMessage", async (params, user) => {
  const messageId = params["message_id"];
  if (typeof messageId !== "string") {
    throw new Error("message_id is required");
  }

  const rows = await plugin.db.query<Message>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`,
    [messageId],
  );
  const existing = rows[0];
  if (!existing) {
    throw new Error("Message not found");
  }

  if (existing.author_id !== user.id) {
    const isMod = await plugin.permissions.hasMinLevel(user.id, 60);
    if (!isMod) {
      throw new Error("Can only delete your own messages or requires moderator");
    }
  }

  // Tombstone — matches the cascade.user.deleted pattern. The row stays so that
  // replies still reference a parent and reply_count stays accurate (tombstones
  // count as visible messages, per Discord parity). Clear attachments so the
  // orphan GC sweep can reclaim the underlying file bytes after the grace
  // window — we never want a deleted message's media to outlive the message.
  await plugin.db.run(
    "UPDATE messages SET content = '[deleted]', author_id = '[deleted]', attachments = NULL WHERE id = ?",
    [messageId],
  );
  plugin.events.publish("text-channels.message.deleted", {
    id: messageId,
    channel_id: existing.channel_id,
    parent_message_id: existing.parent_message_id,
  });
  return { ok: true };
});

plugin.handle("sidebar.items", async (_params, user) => {
  const channels = await plugin.db.query<Channel>(
    `SELECT ${CHANNEL_COLUMNS} FROM channels ORDER BY position ASC, created_at ASC`,
  );
  const isMod = await plugin.permissions.hasMinLevel(user.id, 60);

  const items = channels.map((channel) => {
    const item: {
      id: string;
      label: string;
      icon: string;
      panelType: "plugin";
      slug: string;
      section: string;
      group_id?: string | null;
      adminActions?: Array<{ id: string; label: string; icon: string }>;
    } = {
      id: channel.id,
      label: channel.name,
      icon: "hash",
      panelType: "plugin",
      slug: "text-channels",
      section: "Chat",
      group_id: channel.category_id,
    };

    if (isMod) {
      // Per-item actions only — create-channel lives at section scope below
      // so the create button is available even with zero channels (otherwise
      // a fresh server would render an empty Chat section with no way to
      // create the first channel).
      item.adminActions = [
        { id: "edit-channel", label: "Edit Name", icon: "pencil" },
        { id: "settings-channel", label: "Settings", icon: "settings" },
        { id: "delete-channel", label: "Delete", icon: "trash" },
      ];
    }

    return item;
  });

  // Section-scoped admin actions. The shell prefers these over items[0]
  // adminActions when picking the section "+" button — keeps the create
  // affordance visible regardless of whether any channels exist yet.
  if (isMod) {
    return {
      items,
      adminActions: [{ id: "create-channel", label: "New Channel", icon: "plus" }],
    };
  }
  return { items };
});

// ---------------------------------------------------------------------------
// Presence handlers — typing + viewer counts via sdk.presence (spec-23).
// ---------------------------------------------------------------------------

// Existence checks — presence handlers accept arbitrary ids from clients, and
// registerThreadWatchersIfNeeded grows a module-scope Map per new thread id.
// Without these, any authenticated user can force unbounded watcher growth
// (and presence registry growth) by streaming calls with random UUIDs.

async function requireChannel(channelId: string): Promise<void> {
  const rows = await plugin.db.query<{ id: string }>(
    "SELECT id FROM channels WHERE id = ?",
    [channelId],
  );
  if (rows.length === 0) throw new Error("UNKNOWN_CHANNEL");
}

async function requireThreadRoot(
  messageId: string,
  expectedChannelId?: string,
): Promise<void> {
  const rows = await plugin.db.query<{
    id: string;
    channel_id: string;
    parent_message_id: string | null;
  }>(
    "SELECT id, channel_id, parent_message_id FROM messages WHERE id = ?",
    [messageId],
  );
  const row = rows[0];
  if (!row || row.parent_message_id !== null) {
    throw new Error("UNKNOWN_THREAD");
  }
  if (expectedChannelId !== undefined && row.channel_id !== expectedChannelId) {
    throw new Error("UNKNOWN_THREAD");
  }
}

plugin.handle("setTyping", async (params, user) => {
  const channelId = params["channel_id"];
  if (typeof channelId !== "string") {
    throw new Error("channel_id is required");
  }
  const rawThread = params["thread_id"];
  const threadId = typeof rawThread === "string" ? rawThread : null;
  const typing = params["typing"] === true;

  // Viewer-permission gate keeps users without view access from inflating
  // typing-indicator broadcasts in channels they shouldn't see.
  const canView = await plugin.permissions.check(user.id, "text-channels.view");
  if (!canView) {
    throw new Error("Insufficient permissions: cannot view this channel");
  }

  await requireChannel(channelId);
  if (threadId !== null) {
    await requireThreadRoot(threadId, channelId);
  }

  const scope = threadId === null
    ? channelTypingScope(channelId)
    : threadTypingScope(threadId);

  if (threadId !== null) {
    await registerThreadWatchersIfNeeded(threadId);
  }

  if (typing) {
    await plugin.presence.join(scope, user.id, {
      typing_until: Date.now() + TYPING_TTL_MS,
    });
  } else {
    await plugin.presence.leave(scope, user.id);
  }
  return { ok: true };
});

plugin.handle("setViewingChannel", async (params, user) => {
  const channelId = params["channel_id"];
  if (typeof channelId !== "string") {
    throw new Error("channel_id is required");
  }
  const viewing = params["viewing"] === true;
  const canView = await plugin.permissions.check(user.id, "text-channels.view");
  if (!canView) {
    throw new Error("Insufficient permissions: cannot view this channel");
  }
  await requireChannel(channelId);
  const scope = channelViewersScope(channelId);
  if (viewing) {
    await plugin.presence.join(scope, user.id);
  } else {
    await plugin.presence.leave(scope, user.id);
  }
  return { ok: true };
});

plugin.handle("setViewingThread", async (params, user) => {
  const messageId = params["message_id"];
  if (typeof messageId !== "string") {
    throw new Error("message_id is required");
  }
  const viewing = params["viewing"] === true;
  const canView = await plugin.permissions.check(user.id, "text-channels.view");
  if (!canView) {
    throw new Error("Insufficient permissions: cannot view this channel");
  }
  await requireThreadRoot(messageId);
  await registerThreadWatchersIfNeeded(messageId);
  const scope = threadViewersScope(messageId);
  if (viewing) {
    await plugin.presence.join(scope, user.id);
  } else {
    await plugin.presence.leave(scope, user.id);
  }
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Orphan GC — sweeps the plugin's uploads/ directory and deletes any file
// that (a) isn't referenced by a current messages.attachments row AND
// (b) was last modified more than ORPHAN_GRACE_MS ago. The grace window
// covers in-flight uploads that haven't called sendMessage yet, so we never
// race-delete a file the user is about to attach.
// ---------------------------------------------------------------------------

async function buildReferencedFilenames(): Promise<Set<string>> {
  const referenced = new Set<string>();
  const rows = await plugin.db.query<{ attachments: string | null }>(
    "SELECT attachments FROM messages WHERE attachments IS NOT NULL",
  );
  for (const row of rows) {
    for (const a of parseStoredAttachments(row.attachments)) {
      referenced.add(a.filename);
    }
  }
  return referenced;
}

async function sweepOrphans(): Promise<void> {
  let onDisk: Awaited<ReturnType<typeof plugin.files.list>>;
  try {
    onDisk = await plugin.files.list();
  } catch (err) {
    logWarn("orphan_gc.list_failed", { err: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (onDisk.length === 0) return;

  const referenced = await buildReferencedFilenames();
  const now = Date.now();
  let deleted = 0;
  for (const f of onDisk) {
    if (referenced.has(f.filename)) continue;
    if (now - f.mtime < ORPHAN_GRACE_MS) continue;
    try {
      await plugin.files.delete(f.filename);
      deleted++;
    } catch (err) {
      logWarn("orphan_gc.delete_failed", {
        filename: f.filename,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (deleted > 0) {
    console.error(JSON.stringify({
      level: "info",
      plugin: "text-channels",
      event: "orphan_gc.swept",
      deleted,
      scanned: onDisk.length,
    }));
  }
}

// ---------------------------------------------------------------------------
// Async setup — permissions and event subscriptions.
// These are IPC round-trips that may not resolve until after attachPlugin()
// is called, so they must come AFTER handler registration.
// ---------------------------------------------------------------------------

// Register custom permission: members (level 10+) can post by default
await plugin.permissions.register("text-channels.post", {
  description: "Post messages in text channels",
  default_level: 10,
});

// Register custom permission: anyone (level 1+, guest) can view channels by
// default. Gate exists so admins can later restrict viewer/typing presence to
// specific levels — without it, a level-0 outsider could ping setViewing* /
// setTyping for any channel and inflate the viewer count broadcast back to
// real users (and reveal their own user_id to that channel's audience).
await plugin.permissions.register("text-channels.view", {
  description: "View channels and signal typing/viewing presence",
  default_level: 1,
});

// Cascade: user deletion → anonymize messages
await plugin.events.subscribe(
  "runtime.cascade.user.deleted",
  async (event) => {
    const payload = event.payload as Record<string, unknown>;
    const userId = payload["user_id"];
    if (typeof userId === "string") {
      // Clear attachments alongside the tombstone — see deleteMessage for
      // rationale (orphan GC will reclaim files after the grace window).
      await plugin.db.run(
        "UPDATE messages SET content = '[deleted]', author_id = '[deleted]', attachments = NULL WHERE author_id = ?",
        [userId],
      );
    }
  },
);

// Soft-FK cleanup: when Core deletes a category, NULL out matching channels.
// Channels then render under the "Uncategorized" bucket in the sidebar.
await plugin.events.subscribe(
  "core.category.deleted",
  async (event) => {
    const payload = event.payload as Record<string, unknown>;
    const categoryId = payload["id"];
    if (typeof categoryId !== "string" || categoryId.length === 0) return;
    await plugin.db.run(
      "UPDATE channels SET category_id = NULL WHERE category_id = ?",
      [categoryId],
    );
  },
);

// Presence watchers — register one pair (typing + viewers) per existing
// channel at startup. New channels get watchers via the channel.created
// subscription below. Thread watchers are registered lazily on first
// setTyping / setViewingThread for that thread.
{
  const channels = await plugin.db.query<{ id: string }>("SELECT id FROM channels");
  await Promise.all(channels.map((c) => registerChannelWatchers(c.id)));
}

await plugin.events.subscribe(
  "text-channels.channel.created",
  async (event) => {
    const payload = event.payload as Record<string, unknown>;
    const id = payload["id"];
    if (typeof id === "string") {
      await registerChannelWatchers(id);
    }
  },
);

// Schedule the hourly orphan-GC sweep + run an initial sweep at boot. The
// schedule registration is idempotent across reloads — re-registering the
// same name replaces the previous timer (SDK contract).
//
// Fire-and-forget: schedule.register is a best-effort housekeeping concern
// and we don't want to block plugin startup on the round-trip. A failed
// registration only means files would linger a runtime restart longer.
void plugin.schedule
  .every("attachments.orphan_gc", ORPHAN_GC_INTERVAL_MS, () => sweepOrphans())
  .catch((err) =>
    logWarn("schedule.register failed", { err: err instanceof Error ? err.message : String(err) }),
  );
void sweepOrphans();
