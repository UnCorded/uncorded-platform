// Cross-plugin data read — structured query builder over IPC.

import type { DataReadWhereClause, DataReadOrderBy } from "@uncorded/protocol";
import type { createRequestClient } from "./request";
import type { DataApi, DataReadQuery } from "./types";
import { DataReadResult } from "./schemas";

interface QueryState {
  plugin: string;
  table: string;
  whereClauses: DataReadWhereClause[];
  selectColumns: string[] | undefined;
  orderByClauses: DataReadOrderBy[];
  limitValue: number | undefined;
}

function createQuery<T = Record<string, unknown>>(
  state: QueryState,
  client: ReturnType<typeof createRequestClient>,
): DataReadQuery<T> {
  return {
    where(
      column: string,
      op: DataReadWhereClause["op"],
      value: DataReadWhereClause["value"],
    ): DataReadQuery<T> {
      return createQuery<T>(
        { ...state, whereClauses: [...state.whereClauses, { column, op, value }] },
        client,
      );
    },

    select(columns: string[]): DataReadQuery<T> {
      return createQuery<T>({ ...state, selectColumns: columns }, client);
    },

    orderBy(
      column: string,
      direction: DataReadOrderBy["direction"] = "asc",
    ): DataReadQuery<T> {
      return createQuery<T>(
        { ...state, orderByClauses: [...state.orderByClauses, { column, direction }] },
        client,
      );
    },

    limit(n: number): DataReadQuery<T> {
      return createQuery<T>({ ...state, limitValue: n }, client);
    },

    async exec(): Promise<T[]> {
      const result = await client.sendAndWait(DataReadResult, {
        type: "data.read",
        plugin: state.plugin,
        table: state.table,
        ...(state.whereClauses.length > 0 ? { where: state.whereClauses } : {}),
        ...(state.selectColumns !== undefined ? { select: state.selectColumns } : {}),
        ...(state.orderByClauses.length > 0 ? { order_by: state.orderByClauses } : {}),
        ...(state.limitValue !== undefined ? { limit: state.limitValue } : {}),
      });
      return result as T[];
    },
  };
}

export function createDataApi(
  client: ReturnType<typeof createRequestClient>,
): DataApi {
  return {
    read<T = Record<string, unknown>>(
      plugin: string,
      table: string,
    ): DataReadQuery<T> {
      return createQuery<T>(
        {
          plugin,
          table,
          whereClauses: [],
          selectColumns: undefined,
          orderByClauses: [],
          limitValue: undefined,
        },
        client,
      );
    },
  };
}
