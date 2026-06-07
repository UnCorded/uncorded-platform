// Per-server membership store — exposes the current user's role context for
// the active server (level, role name, owner flag) so the UI can gate admin
// affordances without round-tripping every action to discover a FORBIDDEN.
//
// Server-authoritative: the runtime is still the source of truth on every
// mutating call. This is purely a UI hint.

import { createSignal, createEffect, createMemo, untrack } from "solid-js";
import { activeServerId, activeServer } from "./servers";
import { account } from "./auth";
import { connect, onPluginMessage, request } from "../lib/ws";
import { createTrailingDebouncer } from "../lib/trailing-debounce";

export interface CurrentMember {
  user_id: string;
  is_owner: boolean;
  level: number;
  role_name: string;
  /**
   * Caller's role id, or `null` if owner (owner doesn't have a role row).
   * Used by `useHasPermission` to honour explicit role overrides.
   */
  role_id: number | null;
}

const LEVEL_MOD = 60;
const LEVEL_ADMIN = 80;

const [currentMember, setCurrentMember] = createSignal<CurrentMember | null>(null);

export { currentMember };

// Owner derived synchronously from account + active server, so admin UI
// surfaces immediately and stays correct even when the WS roundtrip for
// core.member.me hasn't resolved (or the runtime predates that action).
const isOwnerByAccount = () => {
  const acc = account();
  const srv = activeServer();
  return !!acc && !!srv && acc.id === srv.owner_id;
};

export const isOwner = () => {
  if (isOwnerByAccount()) return true;
  return currentMember()?.is_owner === true;
};

export const isAdmin = () => {
  if (isOwner()) return true;
  const m = currentMember();
  return !!m && m.level >= LEVEL_ADMIN;
};

export const isMod = () => {
  if (isOwner()) return true;
  const m = currentMember();
  return !!m && m.level >= LEVEL_MOD;
};

export function mountMembershipStore(): void {
  // Tracking activeServer() directly would re-fire on every patchServer
  // (incl. onConnect's is_online flip), spawning a fresh core.member.me
  // request and another connect() call each time. Memoize on a narrow key
  // so unrelated field changes don't reach this effect — same fix as
  // sidebar.ts, see feedback_solid_patcher_cascade.md.
  const activeKey = createMemo(() => {
    const id = activeServerId();
    const server = activeServer();
    if (!id || !server?.tunnel_url) return null;
    return `${id}|${server.tunnel_url}`;
  });

  createEffect(() => {
    const key = activeKey();
    if (!key) {
      setCurrentMember(null);
      return;
    }
    const id = key.slice(0, key.indexOf("|"));
    const server = untrack(activeServer);
    if (!server) return;
    let cancelled = false;
    const refetch = async (): Promise<void> => {
      try {
        const me = await request<CurrentMember>(id, "core", "core.member.me", {});
        if (!cancelled) setCurrentMember(me);
      } catch {
        if (!cancelled) setCurrentMember(null);
      }
    };

    // 200ms trailing debounce per spec-22 Amendment B PR 2.2: bulk grants
    // (matrix Save) emit one `core.permission.changed` per change. A single
    // refetch after the storm is what we want; the debouncer collapses N
    // events into 1 trailing call.
    const debouncer = createTrailingDebouncer<[]>(() => {
      if (!cancelled) void refetch();
    }, 200);

    void (async () => {
      await connect(server);
      if (cancelled) return;
      await refetch();
    })();

    // Subscribe to `core.permission.changed` so role/permission mutations
    // update isOwner/isAdmin/isMod live without page reload. The runtime is
    // authoritative; this keeps the UI gates in sync.
    const unsub = onPluginMessage(
      id,
      "core",
      (msg) => {
        const ev = msg as { type?: string; topic?: string };
        if (ev.type === "event" && ev.topic === "core.permission.changed") {
          debouncer.fire();
        }
      },
      "membership-perm-watch",
    );

    return () => {
      cancelled = true;
      debouncer.cancel();
      unsub();
    };
  });
}
