// Own-database access — routes SQL calls through IPC to the runtime broker.
// The runtime validates the data.sql:self capability before executing.

import type { createRequestClient } from "./request";
import type { IpcMessage } from "./transport";
import type { DbApi, RunResult } from "./types";
import {
  DbQueryResult,
  DbRunResult,
  DbBatchResult,
  unknownResult,
} from "./schemas";

export function createDbApi(client: ReturnType<typeof createRequestClient>): DbApi {
  return {
    async query<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<T[]> {
      const msg: IpcMessage = { type: "data.sql", method: "query", sql };
      if (params !== undefined) msg["params"] = params;
      const result = await client.sendAndWait(DbQueryResult, msg);
      return result as T[];
    },

    async run(sql: string, params?: unknown[]): Promise<RunResult> {
      const msg: IpcMessage = { type: "data.sql", method: "run", sql };
      if (params !== undefined) msg["params"] = params;
      return client.sendAndWait(DbRunResult, msg);
    },

    async exec(sql: string): Promise<void> {
      await client.sendAndWait(unknownResult, {
        type: "data.sql",
        method: "exec",
        sql,
      });
    },

    async batch(
      statements: Array<{ sql: string; params?: unknown[] }>,
    ): Promise<RunResult[]> {
      return client.sendAndWait(DbBatchResult, {
        type: "data.sql",
        method: "transaction",
        statements,
      });
    },
  };
}
