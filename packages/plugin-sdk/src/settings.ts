// Settings — wraps the data.config IPC calls and bridges
// `core.plugin.config_changed` deliveries to local listeners.
//
// Backed by a `_config` table in the plugin's own SQLite database (spec-04
// Amendment A). No capability declaration required — every plugin always
// reads its own settings and receives change deliveries unconditionally.
//
// `get` / `getAll` round-trip to the runtime so that admin-side writes via
// PATCH /admin/api/plugins/:slug/config are observed without restart.

import { z } from "zod";
import type { createRequestClient } from "./request";
import type { SettingsApi, SettingsChangeEvent } from "./types";

const SettingValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const SettingsGetAllResultSchema = z.record(z.string(), SettingValueSchema);

export interface SettingsApiInternal extends SettingsApi {
  /** Internal: dispatch a config-changed delivery to all subscribers. */
  handleChange(event: SettingsChangeEvent): void;
}

export function createSettingsApi(
  client: ReturnType<typeof createRequestClient>,
): SettingsApiInternal {
  const listeners = new Set<(event: SettingsChangeEvent) => void>();

  return {
    async get(key: string): Promise<string | number | boolean> {
      const result = await client.sendAndWait(SettingValueSchema.nullable(), {
        type: "data.config",
        method: "get",
        key,
      });
      if (result === null) {
        throw new Error(`Setting "${key}" returned null — declared default missing?`);
      }
      return result;
    },

    async getAll(): Promise<Record<string, string | number | boolean>> {
      return await client.sendAndWait(SettingsGetAllResultSchema, {
        type: "data.config",
        method: "getAll",
      });
    },

    onChange(handler: (event: SettingsChangeEvent) => void): () => void {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },

    handleChange(event: SettingsChangeEvent): void {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Swallow listener errors — one bad subscriber must not prevent
          // delivery to the others.
        }
      }
    },
  };
}

