// sdk.core — thin IPC wrapper for Core Module user profile reads.
// No capability declaration required; all plugins get these methods.
// Uses explicit IPC type strings (e.g. "core.user.get") so the router
// can bypass capability checks for these built-in runtime services.

import type { CoreUser } from "@uncorded/protocol";
import type { createRequestClient } from "./request";
import type { CoreApi } from "./types";
import { CoreUserGetResult, CoreUsersResult, CoreCategoriesResult } from "./schemas";

export function createCoreApi(client: ReturnType<typeof createRequestClient>): CoreApi {
  return {
    async getUser(userId: string): Promise<CoreUser | null> {
      const { user } = await client.sendAndWait(CoreUserGetResult, {
        type: "core.user.get",
        userId,
      });
      return user;
    },

    async getUsers(userIds: string[]): Promise<CoreUser[]> {
      const { users } = await client.sendAndWait(CoreUsersResult, {
        type: "core.user.getMany",
        userIds,
      });
      return users;
    },

    async getOnlineUsers(): Promise<CoreUser[]> {
      const { users } = await client.sendAndWait(CoreUsersResult, {
        type: "core.user.getOnline",
      });
      return users;
    },

    async listCategories() {
      const { categories } = await client.sendAndWait(CoreCategoriesResult, {
        type: "core.categories.list",
      });
      return categories;
    },
  };
}
