// Key-value store — wraps the data.kv IPC calls.
//
// Backed by a _kv table in the plugin's own SQLite database.
// Requires data.kv:self in the manifest permissions.
//
// Values are always strings — serialize complex values with JSON.stringify.
// The runtime never logs values regardless of content; treat any key whose
// value is sensitive (API keys, tokens) as a secret by declaring type: "secret"
// in the manifest settings field.
//
// Key constraints: non-empty, max 256 chars.
// Value constraints: max 64 KB.

import type { z } from "zod";
import type { createRequestClient } from "./request";
import type { KvApi } from "./types";
import {
  KvGetResult,
  KvListResult,
  KvGetManyResult,
  unknownResult,
} from "./schemas";

export function createKvApi(client: ReturnType<typeof createRequestClient>): KvApi {
  function send<S extends z.ZodTypeAny>(
    schema: S,
    method: string,
    extra?: Record<string, unknown>,
  ): Promise<z.infer<S>> {
    return client.sendAndWait(schema, {
      type: "data.kv",
      method,
      ...extra,
    });
  }

  return {
    async get(key: string): Promise<string | null> {
      return send(KvGetResult, "get", { key });
    },

    async set(key: string, value: string): Promise<void> {
      await send(unknownResult, "set", { key, value });
    },

    async delete(key: string): Promise<void> {
      await send(unknownResult, "delete", { key });
    },

    async list(prefix?: string): Promise<{ key: string; value: string }[]> {
      return send(KvListResult, "list", prefix !== undefined ? { prefix } : {});
    },

    async getMany(keys: string[]): Promise<Record<string, string>> {
      return send(KvGetManyResult, "getMany", { keys });
    },
  };
}
