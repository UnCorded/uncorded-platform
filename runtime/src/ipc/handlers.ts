// IPC handlers — runtime-side logic for plugin permissions and cross-plugin
// data.read messages. Each handler extracts fields from the IPC message,
// delegates to the appropriate runtime service, and sends a response back
// via the plugin's transport.

import type { Database } from "bun:sqlite";
import { rootLogger } from "@uncorded/shared";
import type { PluginSetting } from "@uncorded/shared";
import type { IpcMessage } from "./transport";
import type { IpcTransport } from "./transport";
import { MAX_IPC_LINE_BYTES } from "./transport";
import type { RolesEngine } from "../roles/engine";
import type { PluginRegistry } from "../http/types";
import type {
  DataReadWhereClause,
  DataReadOrderBy,
} from "@uncorded/protocol";
import { join, sep, resolve } from "node:path";
import { readdir, stat, unlink } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { signFilePath, formatSignedFileUrl } from "../signing/files";

const log = rootLogger.child({ component: "ipc" });

/**
 * Headroom between the handler-level response cap and the transport-level
 * hard cap. The envelope — `IPC:` prefix, JSON keys (`type`, `id`), braces,
 * commas — adds a few dozen bytes. 1 KiB is ample headroom to guarantee a
 * handler-bounded response always fits within the transport cap so the plugin
 * sees a catchable RESPONSE_TOO_LARGE error rather than a silent drop.
 */
const IPC_RESPONSE_HEADROOM_BYTES = 1024;

/**
 * Maximum serialized size of a handler's `result` payload before the handler
 * rejects with RESPONSE_TOO_LARGE. Always strictly less than MAX_IPC_LINE_BYTES
 * so the transport safety net never fires on a bounded response.
 */
const MAX_IPC_RESPONSE_BYTES = MAX_IPC_LINE_BYTES - IPC_RESPONSE_HEADROOM_BYTES;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IsOwnerFn = (userId: string) => boolean;
export type OpenDatabaseFn = (pluginSlug: string) => Database;
export type OpenWritableDbFn = (slug: string) => Database;

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function sendResult(transport: IpcTransport, id: string, result: unknown): void {
  transport.send({ type: "response", id, result } as IpcMessage);
}

function sendError(transport: IpcTransport, id: string, code: string, message: string): void {
  transport.send({ type: "response", id, error: { code, message } } as IpcMessage);
}

/**
 * Encode the response payload, check it against the per-response byte cap, and
 * either send the result or send a RESPONSE_TOO_LARGE error. Handlers that can
 * produce large responses (cross-plugin reads, kv.list, kv.getMany) must route
 * their result through this helper so plugins receive a catchable error instead
 * of hitting the transport's silent-drop safety net.
 *
 * The cap is MAX_IPC_LINE_BYTES minus a small headroom for the envelope
 * (type/id/braces/commas) — see IPC_RESPONSE_HEADROOM_BYTES above.
 */
function sendBoundedResult(
  transport: IpcTransport,
  id: string,
  result: unknown,
  maxBytes: number = MAX_IPC_RESPONSE_BYTES,
): void {
  const serialized = JSON.stringify(result);
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > maxBytes) {
    sendError(
      transport,
      id,
      "RESPONSE_TOO_LARGE",
      `Response payload (${String(byteLength)} bytes) exceeds the ${String(maxBytes)}-byte limit. Paginate the query (add limit/cursor) and fetch in chunks.`,
    );
    return;
  }
  sendResult(transport, id, result);
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

function requireString(msg: IpcMessage, field: string): string | null {
  const v = msg[field];
  return typeof v === "string" ? v : null;
}

function requireNumber(msg: IpcMessage, field: string): number | null {
  const v = msg[field];
  return typeof v === "number" ? v : null;
}

function requireArray(msg: IpcMessage, field: string): unknown[] | null {
  const v = msg[field];
  return Array.isArray(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Permissions handlers
// ---------------------------------------------------------------------------

export function handlePermissionsRegister(
  slug: string,
  msg: IpcMessage,
  transport: IpcTransport,
  rolesEngine: RolesEngine,
): void {
  const id = requireString(msg, "id");
  if (id === null) {
    log.warn("missing or non-string id", { method: "permissions.register" });
    return;
  }
  const key = requireString(msg, "key");
  if (key === null) {
    sendError(transport, id, "INVALID_PARAMS", "key must be a string");
    return;
  }
  const description = requireString(msg, "description");
  if (description === null) {
    sendError(transport, id, "INVALID_PARAMS", "description must be a string");
    return;
  }
  const defaultLevel = requireNumber(msg, "default_level");
  if (defaultLevel === null) {
    sendError(transport, id, "INVALID_PARAMS", "default_level must be a number");
    return;
  }

  const result = rolesEngine.registerPermission({
    key,
    description,
    defaultLevel,
    pluginSlug: slug,
  });

  if (!result.ok) {
    sendError(transport, id, result.error.code, result.error.message);
    return;
  }

  sendResult(transport, id, true);
}

export function handlePermissionsCheck(
  msg: IpcMessage,
  transport: IpcTransport,
  rolesEngine: RolesEngine,
  isOwnerFn: IsOwnerFn,
): void {
  const id = requireString(msg, "id");
  if (id === null) {
    log.warn("missing or non-string id", { method: "permissions.check" });
    return;
  }
  const userId = requireString(msg, "user_id");
  if (userId === null) {
    sendError(transport, id, "INVALID_PARAMS", "user_id must be a string");
    return;
  }
  const permission = requireString(msg, "permission");
  if (permission === null) {
    sendError(transport, id, "INVALID_PARAMS", "permission must be a string");
    return;
  }
  const scopeRaw = msg["scope"];
  if (scopeRaw !== undefined && typeof scopeRaw !== "string") {
    sendError(transport, id, "INVALID_PARAMS", "scope must be a string");
    return;
  }
  const scope = scopeRaw as string | undefined;

  const isOwner = isOwnerFn(userId);
  const result = rolesEngine.check(userId, permission, { userId, isOwner }, scope);

  sendResult(transport, id, result);
}

export function handlePermissionsHasRole(
  msg: IpcMessage,
  transport: IpcTransport,
  rolesEngine: RolesEngine,
): void {
  const id = requireString(msg, "id");
  if (id === null) {
    log.warn("missing or non-string id", { method: "permissions.has_role" });
    return;
  }
  const userId = requireString(msg, "user_id");
  if (userId === null) {
    sendError(transport, id, "INVALID_PARAMS", "user_id must be a string");
    return;
  }
  const roleName = requireString(msg, "role_name");
  if (roleName === null) {
    sendError(transport, id, "INVALID_PARAMS", "role_name must be a string");
    return;
  }

  const result = rolesEngine.hasRole(userId, roleName);
  sendResult(transport, id, result);
}

export function handlePermissionsHasMinLevel(
  msg: IpcMessage,
  transport: IpcTransport,
  rolesEngine: RolesEngine,
  isOwnerFn: IsOwnerFn,
): void {
  const id = requireString(msg, "id");
  if (id === null) {
    log.warn("missing or non-string id", { method: "permissions.has_min_level" });
    return;
  }
  const userId = requireString(msg, "user_id");
  if (userId === null) {
    sendError(transport, id, "INVALID_PARAMS", "user_id must be a string");
    return;
  }
  const level = requireNumber(msg, "level");
  if (level === null) {
    sendError(transport, id, "INVALID_PARAMS", "level must be a number");
    return;
  }

  const isOwner = isOwnerFn(userId);
  const result = rolesEngine.hasMinLevel(userId, level, { userId, isOwner });

  sendResult(transport, id, result);
}

export function handlePermissionsGetRole(
  msg: IpcMessage,
  transport: IpcTransport,
  rolesEngine: RolesEngine,
): void {
  const id = requireString(msg, "id");
  if (id === null) {
    log.warn("missing or non-string id", { method: "permissions.get_role" });
    return;
  }
  const userId = requireString(msg, "user_id");
  if (userId === null) {
    sendError(transport, id, "INVALID_PARAMS", "user_id must be a string");
    return;
  }

  const role = rolesEngine.getRole(userId);
  sendResult(transport, id, { name: role.name, level: role.level });
}

export function handlePermissionsCanActOn(
  msg: IpcMessage,
  transport: IpcTransport,
  rolesEngine: RolesEngine,
  isOwnerFn: IsOwnerFn,
): void {
  const id = requireString(msg, "id");
  if (id === null) {
    log.warn("missing or non-string id", { method: "permissions.can_act_on" });
    return;
  }
  const actorId = requireString(msg, "actor_id");
  if (actorId === null) {
    sendError(transport, id, "INVALID_PARAMS", "actor_id must be a string");
    return;
  }
  const targetId = requireString(msg, "target_id");
  if (targetId === null) {
    sendError(transport, id, "INVALID_PARAMS", "target_id must be a string");
    return;
  }

  const isOwner = isOwnerFn(actorId);
  const result = rolesEngine.canActOn(actorId, targetId, { userId: actorId, isOwner });

  sendResult(transport, id, result);
}

// ---------------------------------------------------------------------------
// SQL builder for structured cross-plugin reads
// ---------------------------------------------------------------------------

const VALID_OPS = new Set(["=", "!=", "<", ">", "<=", ">=", "LIKE"]);
const MAX_LIMIT = 10_000;
const DEFAULT_LIMIT = 100;

function quoteId(name: string): string {
  // Double-quote identifier, escape any embedded double quotes
  return `"${name.replace(/"/g, '""')}"`;
}

export function buildSelectQuery(
  table: string,
  publicColumns: readonly string[],
  select?: readonly string[],
  where?: readonly DataReadWhereClause[],
  orderBy?: readonly DataReadOrderBy[],
  limit?: number,
): { sql: string; params: (string | number | boolean | null)[] } {
  const columns = select ?? publicColumns;
  const params: (string | number | boolean | null)[] = [];

  let sql = `SELECT ${columns.map(quoteId).join(", ")} FROM ${quoteId(table)}`;

  if (where && where.length > 0) {
    const clauses = where.map((w) => {
      params.push(w.value);
      return `${quoteId(w.column)} ${w.op} ?`;
    });
    sql += ` WHERE ${clauses.join(" AND ")}`;
  }

  if (orderBy && orderBy.length > 0) {
    const orders = orderBy.map(
      (o) => `${quoteId(o.column)} ${o.direction === "desc" ? "DESC" : "ASC"}`,
    );
    sql += ` ORDER BY ${orders.join(", ")}`;
  }

  const effectiveLimit = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  sql += ` LIMIT ${effectiveLimit}`;

  return { sql, params };
}

// ---------------------------------------------------------------------------
// Cross-plugin data.read handler
// ---------------------------------------------------------------------------

/**
 * Default database opener — uses the plugin's dataDir to find the DB file.
 * Tests inject a custom opener to avoid file system access.
 */
function defaultOpenDatabase(registry: PluginRegistry): OpenDatabaseFn {
  return (pluginSlug: string) => {
    const info = registry.getPlugin(pluginSlug);
    if (!info) throw new Error(`Plugin "${pluginSlug}" not found in registry.`);
    const dbPath = join(info.dataDir, `${pluginSlug}.db`);
    // Dynamic import at module level isn't needed — Bun provides Database globally
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database: BunDatabase } = require("bun:sqlite") as typeof import("bun:sqlite");
    return new BunDatabase(dbPath, { readonly: true });
  };
}

export function handleDataRead(
  _slug: string,
  msg: IpcMessage,
  transport: IpcTransport,
  registry: PluginRegistry,
  openDb?: OpenDatabaseFn,
): void {
  const id = requireString(msg, "id");
  if (id === null) {
    log.warn("missing or non-string id", { method: "data.read" });
    return;
  }
  const targetPlugin = requireString(msg, "plugin");
  if (targetPlugin === null) {
    sendError(transport, id, "INVALID_PARAMS", "plugin must be a string");
    return;
  }
  const table = requireString(msg, "table");
  if (table === null) {
    sendError(transport, id, "INVALID_PARAMS", "table must be a string");
    return;
  }

  // Validate optional select: must be array of strings if present
  const selectRaw = msg["select"];
  if (selectRaw !== undefined) {
    if (!Array.isArray(selectRaw) || !selectRaw.every((c) => typeof c === "string")) {
      sendError(transport, id, "INVALID_PARAMS", "select must be an array of strings");
      return;
    }
  }
  const selectCols = selectRaw as string[] | undefined;

  // Validate optional where: must be array of {column: string, op: string, value: any}
  const whereRaw = msg["where"];
  if (whereRaw !== undefined) {
    if (!Array.isArray(whereRaw)) {
      sendError(transport, id, "INVALID_PARAMS", "where must be an array");
      return;
    }
    for (const clause of whereRaw) {
      if (
        typeof clause !== "object" ||
        clause === null ||
        typeof (clause as Record<string, unknown>)["column"] !== "string" ||
        typeof (clause as Record<string, unknown>)["op"] !== "string"
      ) {
        sendError(transport, id, "INVALID_PARAMS", "each where clause must have column (string) and op (string)");
        return;
      }
    }
  }
  const whereClauses = whereRaw as DataReadWhereClause[] | undefined;

  // Validate optional order_by: must be array of {column: string, direction: string}
  const orderByRaw = msg["order_by"];
  if (orderByRaw !== undefined) {
    if (!Array.isArray(orderByRaw) || !orderByRaw.every(
      (o) => typeof o === "object" && o !== null &&
        typeof (o as Record<string, unknown>)["column"] === "string",
    )) {
      sendError(transport, id, "INVALID_PARAMS", "order_by must be an array of objects with column (string)");
      return;
    }
  }
  const orderByClauses = orderByRaw as DataReadOrderBy[] | undefined;

  // Validate optional limit: must be a number if present
  const limitRaw = msg["limit"];
  if (limitRaw !== undefined && typeof limitRaw !== "number") {
    sendError(transport, id, "INVALID_PARAMS", "limit must be a number");
    return;
  }
  const limit = limitRaw as number | undefined;

  // 1. Look up target plugin
  const pluginInfo = registry.getPlugin(targetPlugin);
  if (!pluginInfo) {
    sendError(transport, id, "PLUGIN_NOT_FOUND", `Plugin "${targetPlugin}" is not registered.`);
    return;
  }

  // 2. Validate public_schema exists
  const publicSchema = pluginInfo.manifest.public_schema;
  if (!publicSchema) {
    sendError(transport, id, "NO_PUBLIC_SCHEMA", `Plugin "${targetPlugin}" does not expose a public schema.`);
    return;
  }

  // 3. Validate table is in public_schema
  const tableSchema = publicSchema[table];
  if (!tableSchema) {
    sendError(transport, id, "TABLE_NOT_PUBLIC", `Table "${table}" is not in "${targetPlugin}" public schema.`);
    return;
  }

  const publicColumns = tableSchema.columns;
  const publicSet = new Set(publicColumns);

  // 4. Validate select columns
  if (selectCols) {
    for (const col of selectCols) {
      if (!publicSet.has(col)) {
        sendError(transport, id, "COLUMN_NOT_PUBLIC",
          `Column "${col}" is not in the public schema for "${targetPlugin}.${table}".`);
        return;
      }
    }
  }

  // 5. Validate where columns and operators
  if (whereClauses) {
    for (const w of whereClauses) {
      if (!publicSet.has(w.column)) {
        sendError(transport, id, "COLUMN_NOT_PUBLIC",
          `Column "${w.column}" is not in the public schema for "${targetPlugin}.${table}".`);
        return;
      }
      if (!VALID_OPS.has(w.op)) {
        sendError(transport, id, "INVALID_OPERATOR",
          `Operator "${w.op}" is not allowed. Valid: ${[...VALID_OPS].join(", ")}.`);
        return;
      }
    }
  }

  // 6. Validate order_by columns
  if (orderByClauses) {
    for (const o of orderByClauses) {
      if (!publicSet.has(o.column)) {
        sendError(transport, id, "COLUMN_NOT_PUBLIC",
          `Column "${o.column}" is not in the public schema for "${targetPlugin}.${table}".`);
        return;
      }
    }
  }

  // 7. Build and execute query
  const { sql, params } = buildSelectQuery(table, publicColumns, selectCols, whereClauses, orderByClauses, limit);

  let db: Database | undefined;
  try {
    const opener = openDb ?? defaultOpenDatabase(registry);
    db = opener(targetPlugin);
    const rows = db.query(sql).all(...params);
    sendBoundedResult(transport, id, rows);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(transport, id, "DATA_READ_FAILED", `Failed to read from "${targetPlugin}.${table}": ${message}`);
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed or never opened
    }
  }
}

// ---------------------------------------------------------------------------
// data.kv handler
// ---------------------------------------------------------------------------

const KV_MAX_KEY_BYTES = 256;
const KV_MAX_VALUE_BYTES = 64 * 1024; // 64 KB

const ENSURE_KV_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS _kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)";

export function handleKv(
  slug: string,
  msg: IpcMessage,
  transport: IpcTransport,
  openDb: OpenWritableDbFn,
): void {
  const id = requireString(msg, "id");
  if (id === null) {
    log.warn("missing or non-string id", { method: "data.kv", plugin: slug });
    return;
  }

  const method = requireString(msg, "method");
  if (method === null || !["get", "set", "delete", "list", "getMany"].includes(method)) {
    sendError(transport, id, "INVALID_PARAMS", `unknown kv method: ${String(method)}`);
    return;
  }

  try {
    const db = openDb(slug);
    db.exec(ENSURE_KV_TABLE_SQL);

    if (method === "get") {
      const key = requireString(msg, "key");
      if (key === null || key.length === 0) {
        sendError(transport, id, "INVALID_PARAMS", "key must be a non-empty string");
        return;
      }
      if (key.length > KV_MAX_KEY_BYTES) {
        sendError(transport, id, "INVALID_PARAMS", `key must not exceed ${KV_MAX_KEY_BYTES} characters`);
        return;
      }
      const row = db.query<{ value: string }, [string]>(
        "SELECT value FROM _kv WHERE key = ?",
      ).get(key);
      // Value intentionally not logged — may be a secret setting.
      sendResult(transport, id, row?.value ?? null);
      return;
    }

    if (method === "set") {
      const key = requireString(msg, "key");
      if (key === null || key.length === 0) {
        sendError(transport, id, "INVALID_PARAMS", "key must be a non-empty string");
        return;
      }
      if (key.length > KV_MAX_KEY_BYTES) {
        sendError(transport, id, "INVALID_PARAMS", `key must not exceed ${KV_MAX_KEY_BYTES} characters`);
        return;
      }
      const value = requireString(msg, "value");
      if (value === null) {
        sendError(transport, id, "INVALID_PARAMS", "value must be a string");
        return;
      }
      if (value.length > KV_MAX_VALUE_BYTES) {
        sendError(transport, id, "INVALID_PARAMS", `value must not exceed ${KV_MAX_VALUE_BYTES} characters`);
        return;
      }
      db.query("INSERT OR REPLACE INTO _kv (key, value) VALUES (?, ?)").run(key, value);
      // Key logged, value not — value may be a secret.
      sendResult(transport, id, null);
      return;
    }

    if (method === "delete") {
      const key = requireString(msg, "key");
      if (key === null || key.length === 0) {
        sendError(transport, id, "INVALID_PARAMS", "key must be a non-empty string");
        return;
      }
      if (key.length > KV_MAX_KEY_BYTES) {
        sendError(transport, id, "INVALID_PARAMS", `key must not exceed ${KV_MAX_KEY_BYTES} characters`);
        return;
      }
      db.query("DELETE FROM _kv WHERE key = ?").run(key);
      sendResult(transport, id, null);
      return;
    }

    if (method === "list") {
      const prefix = msg["prefix"];
      if (prefix !== undefined && typeof prefix !== "string") {
        sendError(transport, id, "INVALID_PARAMS", "prefix must be a string if provided");
        return;
      }

      let rows: { key: string; value: string }[];
      if (prefix !== undefined && prefix.length > 0) {
        // Escape LIKE special chars in the prefix, then append %.
        const escaped = prefix.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
        rows = db.query<{ key: string; value: string }, [string]>(
          "SELECT key, value FROM _kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key",
        ).all(escaped + "%");
      } else {
        rows = db.query<{ key: string; value: string }, []>(
          "SELECT key, value FROM _kv ORDER BY key",
        ).all();
      }
      // Keys are safe to return; values are returned as-is since the plugin needs them.
      sendBoundedResult(transport, id, rows);
      return;
    }

    if (method === "getMany") {
      const keysRaw = requireArray(msg, "keys");
      if (keysRaw === null) {
        sendError(transport, id, "INVALID_PARAMS", "keys must be an array");
        return;
      }
      for (let i = 0; i < keysRaw.length; i++) {
        if (typeof keysRaw[i] !== "string") {
          sendError(transport, id, "INVALID_PARAMS", `keys[${i}] must be a string`);
          return;
        }
      }
      const keys = keysRaw as string[];
      if (keys.length === 0) {
        sendResult(transport, id, {});
        return;
      }
      // Build a parameterized IN clause.
      const placeholders = keys.map(() => "?").join(", ");
      const rows = db.query<{ key: string; value: string }, string[]>(
        `SELECT key, value FROM _kv WHERE key IN (${placeholders})`,
      ).all(...keys);
      const result: Record<string, string> = {};
      for (const row of rows) result[row.key] = row.value;
      sendBoundedResult(transport, id, result);
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(transport, id, "KV_ERROR", message);
  }
}

// ---------------------------------------------------------------------------
// data.config handler — plugin reads its own _config table
// ---------------------------------------------------------------------------

/**
 * Idempotent bootstrap. Mirrors the _kv pattern. Called inside handleConfig
 * and also exported for the admin-endpoint side.
 */
export const ENSURE_CONFIG_TABLE_SQL = `CREATE TABLE IF NOT EXISTS _config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('string','secret','number','boolean')),
  updated_at INTEGER NOT NULL,
  updated_by_user_id TEXT
)`;

/** Decode a stored TEXT value back to its declared type. */
export function decodeConfigValue(value: string, type: PluginSetting["type"]): string | number | boolean {
  if (type === "boolean") return value === "true";
  if (type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return value;
}

/** Encode a runtime value to TEXT for storage. */
export function encodeConfigValue(value: string | number | boolean, type: PluginSetting["type"]): string {
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") return String(value);
  return String(value);
}

/**
 * Merge stored rows with manifest defaults so callers never see undefined for
 * a declared key. Stored rows win.
 */
export function mergeConfigWithDefaults(
  manifestSettings: PluginSetting[] | undefined,
  storedRows: { key: string; value: string; type: string }[],
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  if (manifestSettings) {
    for (const setting of manifestSettings) {
      if (setting.default !== undefined) {
        result[setting.key] = setting.default;
      } else if (setting.type === "boolean") {
        result[setting.key] = false;
      } else if (setting.type === "number") {
        result[setting.key] = 0;
      } else {
        result[setting.key] = "";
      }
    }
  }
  for (const row of storedRows) {
    result[row.key] = decodeConfigValue(row.value, row.type as PluginSetting["type"]);
  }
  return result;
}

export function handleConfig(
  slug: string,
  msg: IpcMessage,
  transport: IpcTransport,
  openDb: OpenWritableDbFn,
  getManifestSettings: (slug: string) => PluginSetting[] | undefined,
): void {
  const id = requireString(msg, "id");
  if (id === null) {
    log.warn("missing or non-string id", { method: "data.config", plugin: slug });
    return;
  }

  const method = requireString(msg, "method");
  if (method === null || (method !== "get" && method !== "getAll")) {
    sendError(transport, id, "INVALID_PARAMS", `unknown config method: ${String(method)}`);
    return;
  }

  try {
    const db = openDb(slug);
    db.exec(ENSURE_CONFIG_TABLE_SQL);
    const settings = getManifestSettings(slug);
    const rows = db.query<{ key: string; value: string; type: string }, []>(
      "SELECT key, value, type FROM _config",
    ).all();
    const merged = mergeConfigWithDefaults(settings, rows);

    if (method === "getAll") {
      sendBoundedResult(transport, id, merged);
      return;
    }

    const key = requireString(msg, "key");
    if (key === null || key.length === 0) {
      sendError(transport, id, "INVALID_PARAMS", "key must be a non-empty string");
      return;
    }
    const declared = settings?.some((s) => s.key === key) ?? false;
    if (!declared) {
      sendError(transport, id, "UNKNOWN_SETTING", `Setting "${key}" is not declared in the plugin manifest.`);
      return;
    }
    sendBoundedResult(transport, id, merged[key] ?? null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(transport, id, "CONFIG_ERROR", message);
  }
}

// ---------------------------------------------------------------------------
// http.fetch handler
// ---------------------------------------------------------------------------

/**
 * Request headers always stripped — regardless of target.
 * - host: prevents request smuggling via virtual-host confusion.
 * - cookie: prevents session-hijacking against Central or any cookie-authed service.
 */
const ALWAYS_FORBIDDEN_HEADERS = new Set(["host", "cookie"]);

/** Hard timeout for outbound fetch requests. */
const HTTP_FETCH_TIMEOUT_MS = 30_000;

/** Maximum response body size — protects runtime memory from runaway responses. */
const HTTP_FETCH_MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

export async function handleHttpFetch(
  _slug: string,
  msg: IpcMessage,
  transport: IpcTransport,
  /** Central hostname (e.g. "central.uncorded.app"). Authorization is stripped on requests to this host only. */
  centralHost?: string,
): Promise<void> {
  const id = requireString(msg, "id");
  if (id === null) {
    log.warn("missing or non-string id", { method: "http.fetch" });
    return;
  }

  const url = requireString(msg, "url");
  if (url === null) {
    sendError(transport, id, "INVALID_PARAMS", "url must be a string");
    return;
  }

  const declaredHost = requireString(msg, "host");
  if (declaredHost === null) {
    sendError(transport, id, "INVALID_PARAMS", "host must be a string");
    return;
  }

  // Parse URL and reject non-http(s) schemes first.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    sendError(transport, id, "INVALID_URL", `Could not parse URL: ${url}`);
    return;
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    sendError(transport, id, "INVALID_URL", "Only http: and https: URLs are allowed.");
    return;
  }

  // Cross-check: the declared host field must match the URL's actual hostname.
  // Prevents a plugin from lying about the host to bypass the capability check.
  if (parsedUrl.hostname !== declaredHost) {
    sendError(
      transport,
      id,
      "HOST_MISMATCH",
      `URL hostname "${parsedUrl.hostname}" does not match declared host "${declaredHost}".`,
    );
    return;
  }

  // Build request headers, stripping forbidden entries (case-insensitive).
  // Authorization is additionally stripped when targeting Central — prevents
  // a plugin from using a user token to make authenticated Central API calls.
  const isCentralTarget = centralHost !== undefined && parsedUrl.hostname === centralHost;
  const rawHeaders = msg["headers"];
  const requestHeaders: Record<string, string> = {};
  if (
    rawHeaders !== undefined &&
    typeof rawHeaders === "object" &&
    rawHeaders !== null &&
    !Array.isArray(rawHeaders)
  ) {
    for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      const lowerKey = key.toLowerCase();
      if (ALWAYS_FORBIDDEN_HEADERS.has(lowerKey)) continue;
      if (isCentralTarget && lowerKey === "authorization") continue;
      requestHeaders[key] = value;
    }
  }

  const method = typeof msg["method"] === "string" ? msg["method"].toUpperCase() : "GET";
  const requestBody = typeof msg["body"] === "string" ? msg["body"] : undefined;

  // Abort controller for the 30-second timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      ...(requestBody !== undefined ? { body: requestBody } : {}),
      // Never follow redirects — a 301 to a different host would bypass the allowlist.
      redirect: "manual",
      signal: controller.signal,
    });

    clearTimeout(timer);

    // Buffer entire response and enforce size cap.
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > HTTP_FETCH_MAX_BODY_BYTES) {
      sendError(
        transport,
        id,
        "RESPONSE_TOO_LARGE",
        `Response body (${buffer.byteLength} bytes) exceeds the ${HTTP_FETCH_MAX_BODY_BYTES}-byte limit.`,
      );
      return;
    }

    // Collect response headers into a plain object.
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Always base64-encode the body — consistent wire format regardless of content type.
    const bodyBase64 = Buffer.from(new Uint8Array(buffer)).toString("base64");

    sendResult(transport, id, {
      status: response.status,
      headers: responseHeaders,
      body: bodyBase64,
      encoding: "base64",
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      sendError(transport, id, "FETCH_TIMEOUT", `Request timed out after ${HTTP_FETCH_TIMEOUT_MS}ms.`);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      sendError(transport, id, "FETCH_FAILED", `Fetch failed: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// PluginDbCache — lazily opens writable SQLite handles per plugin slug
// ---------------------------------------------------------------------------

/** Valid SQLite parameter value types. */
type SqlParam = string | number | boolean | null | bigint;

/** Result of one wal_checkpoint(TRUNCATE) call. */
export interface CheckpointResult {
  slug: string;
  ok: boolean;
  /** Present iff ok=false. */
  err?: string;
}

/**
 * Lazily opens and caches a writable SQLite database for each plugin.
 * Enables WAL mode on first open. Handles are cached for the lifetime
 * of the runtime process; use close() for cleanup.
 */
export class PluginDbCache {
  private cache = new Map<string, Database>();

  constructor(private pluginsDir: string) {}

  /** Returns (or lazily opens) the writable DB handle for the given plugin slug. */
  get(slug: string): Database {
    const existing = this.cache.get(slug);
    if (existing) return existing;

    const { Database: BunDatabase } = require("bun:sqlite") as typeof import("bun:sqlite");
    const dbPath = join(this.pluginsDir, slug, `${slug}.db`);
    const db = new BunDatabase(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    this.cache.set(slug, db);
    return db;
  }

  /** Close and evict the cached handle for the given plugin slug. */
  close(slug: string): void {
    const db = this.cache.get(slug);
    if (db) {
      try {
        db.close();
      } catch {
        // Already closed
      }
      this.cache.delete(slug);
    }
  }

  /**
   * Run `PRAGMA wal_checkpoint(TRUNCATE)` against every open plugin DB.
   *
   * Why TRUNCATE rather than the default PASSIVE: a long-running plugin that
   * writes steadily but reads rarely (no implicit checkpoints from reader
   * passes) lets the `-wal` file grow without bound — pages stay in the WAL
   * even after they've been merged into the main file. PASSIVE would block
   * if any reader is mid-transaction and skip the truncate; TRUNCATE waits
   * for active readers and then resets the WAL file to the header. We accept
   * the brief lock so disk usage is bounded.
   *
   * Errors per-DB are captured into the returned array rather than thrown:
   * one misbehaving plugin DB cannot starve checkpoints on the others, and
   * the periodic timer in main.ts must not surface sync exceptions.
   */
  checkpointAll(): CheckpointResult[] {
    const results: CheckpointResult[] = [];
    for (const [slug, db] of this.cache) {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        results.push({ slug, ok: true });
      } catch (err: unknown) {
        results.push({
          slug,
          ok: false,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// data.sql handler
// ---------------------------------------------------------------------------

/** Validate that every element of params is a SQL-safe primitive. */
function validateSqlParams(params: unknown[]): string | null {
  for (let i = 0; i < params.length; i++) {
    const v = params[i];
    if (
      v === null ||
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean" ||
      typeof v === "bigint"
    ) {
      continue;
    }
    return `params[${i}] is not a valid SQL parameter (must be string, number, boolean, null, or bigint)`;
  }
  return null;
}

export function handleDataSql(
  slug: string,
  msg: IpcMessage,
  transport: IpcTransport,
  openDb: OpenWritableDbFn,
): void {
  const id = requireString(msg, "id");
  if (id === null) {
    log.warn("missing or non-string id", { method: "data.sql" });
    return;
  }

  const method = requireString(msg, "method");
  if (method === null) {
    sendError(transport, id, "INVALID_PARAMS", "method must be a string");
    return;
  }

  if (!["run", "query", "exec", "transaction"].includes(method)) {
    sendError(transport, id, "INVALID_PARAMS", `unknown method: ${method}`);
    return;
  }

  if (method === "transaction") {
    // Validate statements array
    const statementsRaw = requireArray(msg, "statements");
    if (statementsRaw === null) {
      sendError(transport, id, "INVALID_PARAMS", "statements must be an array");
      return;
    }
    for (let i = 0; i < statementsRaw.length; i++) {
      const s = statementsRaw[i];
      if (typeof s !== "object" || s === null || typeof (s as Record<string, unknown>)["sql"] !== "string") {
        sendError(transport, id, "INVALID_PARAMS", `statements[${i}].sql must be a string`);
        return;
      }
      const sParams = (s as Record<string, unknown>)["params"];
      if (sParams !== undefined) {
        if (!Array.isArray(sParams)) {
          sendError(transport, id, "INVALID_PARAMS", `statements[${i}].params must be an array`);
          return;
        }
        const paramErr = validateSqlParams(sParams as unknown[]);
        if (paramErr !== null) {
          sendError(transport, id, "INVALID_PARAMS", `statements[${i}].${paramErr}`);
          return;
        }
      }
    }

    try {
      const db = openDb(slug);
      const results: { changes: number; lastInsertRowid: number | bigint }[] = [];
      const transaction = db.transaction(() => {
        for (const s of statementsRaw) {
          const stmt = s as { sql: string; params?: SqlParam[] };
          const prepared = db.query(stmt.sql);
          const params: SqlParam[] = stmt.params ?? [];
          const info = prepared.run(...params);
          results.push({ changes: info.changes, lastInsertRowid: info.lastInsertRowid });
        }
      });
      transaction();
      sendResult(transport, id, results);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(transport, id, "DATABASE_ERROR", message);
    }
    return;
  }

  // run, query, exec all require sql
  const sql = requireString(msg, "sql");
  if (sql === null) {
    sendError(transport, id, "INVALID_PARAMS", "sql must be a string");
    return;
  }

  // Validate params if present
  let params: SqlParam[] | undefined;
  if (method !== "exec") {
    const paramsRaw = msg["params"];
    if (paramsRaw !== undefined) {
      if (!Array.isArray(paramsRaw)) {
        sendError(transport, id, "INVALID_PARAMS", "params must be an array");
        return;
      }
      const paramErr = validateSqlParams(paramsRaw as unknown[]);
      if (paramErr !== null) {
        sendError(transport, id, "INVALID_PARAMS", paramErr);
        return;
      }
      params = paramsRaw as SqlParam[];
    }
  }

  try {
    const db = openDb(slug);

    if (method === "exec") {
      db.exec(sql);
      sendResult(transport, id, null);
    } else if (method === "run") {
      const prepared = db.query(sql);
      const info = prepared.run(...(params ?? []));
      sendResult(transport, id, { changes: info.changes, lastInsertRowid: info.lastInsertRowid });
    } else {
      // query
      const prepared = db.query(sql);
      const rows = prepared.all(...(params ?? []));
      sendResult(transport, id, rows);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(transport, id, "DATABASE_ERROR", message);
  }
}

// ---------------------------------------------------------------------------
// storage.file handler — plugin file management against its own uploads dir.
//
// Methods:
//   - stat     : returns { exists, size, mtime } for one filename
//   - signUrl  : mints a signed URL for { filename, user_id, ttl_seconds? }
//   - delete   : removes a file from the plugin's uploads/ (used for GC)
//   - list     : returns { filename, size, mtime }[] (used for GC sweep)
//
// All four are scoped to the plugin's own `<dataDir>/uploads/` directory.
// The capability gate runs upstream (router.ts) against `storage.file:self`.
//
// Filename validation: only `[a-zA-Z0-9_.-]+` is accepted. This rejects path
// separators and `..` while still permitting the UUID-with-extension names
// produced by the upload handler.
// ---------------------------------------------------------------------------

const FILENAME_RE = /^[a-zA-Z0-9_.-]+$/;

function isValidFilename(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name === "." || name === "..") return false;
  return FILENAME_RE.test(name);
}

export function handleFiles(
  slug: string,
  msg: IpcMessage,
  transport: IpcTransport,
  pluginRegistry: PluginRegistry,
): void {
  const id = requireString(msg, "id");
  if (id === null) {
    log.warn("missing or non-string id", { method: "storage.file", plugin: slug });
    return;
  }

  const method = requireString(msg, "method");
  if (method === null) {
    sendError(transport, id, "INVALID_PARAMS", "method must be a string");
    return;
  }

  const plugin = pluginRegistry.getPlugin(slug);
  if (!plugin) {
    sendError(transport, id, "PLUGIN_NOT_FOUND", `Plugin "${slug}" not found.`);
    return;
  }

  const uploadsDir = resolve(plugin.dataDir, "uploads");

  // Helper: resolve a filename to its absolute path or send INVALID_PARAMS.
  const resolveFile = (filename: string): string | null => {
    if (!isValidFilename(filename)) {
      sendError(transport, id, "INVALID_PARAMS", "filename must match [a-zA-Z0-9_.-]+ and be 1-255 chars");
      return null;
    }
    const p = resolve(uploadsDir, filename);
    if (p !== uploadsDir && !p.startsWith(uploadsDir + sep)) {
      sendError(transport, id, "INVALID_PARAMS", "filename resolves outside uploads directory");
      return null;
    }
    return p;
  };

  (async () => {
    try {
      switch (method) {
        case "stat": {
          const filename = requireString(msg, "filename");
          if (filename === null) {
            sendError(transport, id, "INVALID_PARAMS", "filename must be a string");
            return;
          }
          const path = resolveFile(filename);
          if (path === null) return;
          try {
            const s = await stat(path);
            sendResult(transport, id, {
              exists: true,
              size: s.size,
              mtime: Math.floor(s.mtimeMs),
            });
          } catch {
            sendResult(transport, id, { exists: false, size: 0, mtime: 0 });
          }
          return;
        }
        case "signUrl": {
          const filename = requireString(msg, "filename");
          if (filename === null) {
            sendError(transport, id, "INVALID_PARAMS", "filename must be a string");
            return;
          }
          if (!isValidFilename(filename)) {
            sendError(transport, id, "INVALID_PARAMS", "filename must match [a-zA-Z0-9_.-]+ and be 1-255 chars");
            return;
          }
          const userId = requireString(msg, "user_id");
          if (userId === null || userId.length === 0) {
            sendError(transport, id, "INVALID_PARAMS", "user_id must be a non-empty string");
            return;
          }
          if (userId.length > 256) {
            sendError(transport, id, "INVALID_PARAMS", "user_id must not exceed 256 characters");
            return;
          }
          const ttlRaw = msg["ttl_seconds"];
          let ttl: number | undefined;
          if (ttlRaw !== undefined) {
            if (typeof ttlRaw !== "number" || !Number.isFinite(ttlRaw) || ttlRaw <= 0 || ttlRaw > 86400) {
              sendError(transport, id, "INVALID_PARAMS", "ttl_seconds must be a positive number ≤ 86400");
              return;
            }
            ttl = ttlRaw;
          }
          const path = `/files/${slug}/${filename}`;
          const sig = signFilePath(path, userId, ttl);
          sendResult(transport, id, {
            url: formatSignedFileUrl(path, sig),
            exp: sig.exp,
          });
          return;
        }
        case "delete": {
          const filename = requireString(msg, "filename");
          if (filename === null) {
            sendError(transport, id, "INVALID_PARAMS", "filename must be a string");
            return;
          }
          const path = resolveFile(filename);
          if (path === null) return;
          try {
            await unlink(path);
            sendResult(transport, id, { deleted: true });
          } catch (err) {
            // ENOENT — already gone, idempotent success
            const e = err as NodeJS.ErrnoException;
            if (e?.code === "ENOENT") {
              sendResult(transport, id, { deleted: false });
              return;
            }
            sendError(transport, id, "DELETE_FAILED", e?.message ?? String(err));
          }
          return;
        }
        case "list": {
          let entries: string[];
          try {
            entries = await readdir(uploadsDir);
          } catch {
            sendBoundedResult(transport, id, []);
            return;
          }
          const out: { filename: string; size: number; mtime: number }[] = [];
          for (const name of entries) {
            if (!isValidFilename(name)) continue;
            // Skip in-flight uploads — plugin GC must not delete them.
            if (name.endsWith(".tmp")) continue;
            try {
              const s = await stat(join(uploadsDir, name));
              out.push({ filename: name, size: s.size, mtime: Math.floor(s.mtimeMs) });
            } catch {
              // unreadable entry — skip silently
            }
          }
          sendBoundedResult(transport, id, out);
          return;
        }
        default:
          sendError(transport, id, "INVALID_PARAMS", `unknown storage.file method: ${method}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(transport, id, "STORAGE_ERROR", message);
    }
  })();
}
