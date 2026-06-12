import { createSignal } from "solid-js";
import * as central from "../api/central";
import { ApiError, type MyInvite } from "../api/types";
import { account } from "./auth";
import { loadServers, setActiveServer } from "./servers";

// Pending invitations addressed to the signed-in account. Lives as a store —
// not component state — because the two surfaces that render invites
// (the server-switcher dropdown and the sidebar's no-server view) are
// mounted in mutually exclusive states: the switcher only exists when a
// server is active, which is exactly when a brand-new invitee has nothing.
// Component-local state in the switcher meant a user's FIRST invite was
// invisible until they somehow already had a server.
//
// Liveness matches the server list: a 60s background poll plus a throttled
// focus refresh (Central has no client push channel), so a fresh invite
// shows up without a page reload.

const [myInvites, setMyInvites] = createSignal<MyInvite[]>([]);
const [inviteBusyId, setInviteBusyId] = createSignal<string | null>(null);
const [inviteError, setInviteError] = createSignal<string | null>(null);

export { myInvites, inviteBusyId, inviteError };

let _pollHandle: ReturnType<typeof setInterval> | null = null;
let _focusHooked = false;
let _lastRefreshAt = 0;

const INVITE_POLL_INTERVAL_MS = 60_000;
const FOCUS_REFRESH_THROTTLE_MS = 5_000;

export async function refreshInvites(): Promise<void> {
  // Skip while logged out — a guaranteed 401 the browser would log to the
  // console even though we swallow the rejection.
  if (account() === null) return;
  _lastRefreshAt = Date.now();
  try {
    setMyInvites(await central.listMyInvites());
  } catch {
    // Central unreachable — keep whatever we had.
  }
}

/** Idempotent: install the 60s poll + focus refresh once. Callers are the
 *  always-mounted surfaces (AppSidebar); safe to call from several. */
export function ensureInvitePolling(): void {
  if (typeof window !== "undefined" && !_focusHooked) {
    _focusHooked = true;
    window.addEventListener("focus", () => {
      if (Date.now() - _lastRefreshAt > FOCUS_REFRESH_THROTTLE_MS) void refreshInvites();
    });
  }
  if (_pollHandle !== null) return;
  _pollHandle = setInterval(() => void refreshInvites(), INVITE_POLL_INTERVAL_MS);
}

/** Stop the background poll. Tests use this to avoid leaks. */
export function stopInvitePolling(): void {
  if (_pollHandle === null) return;
  clearInterval(_pollHandle);
  _pollHandle = null;
}

/** Accept an invite: join, refresh both lists, switch to the new server.
 *  Returns true on success; failures land in inviteError. */
export async function acceptInviteAction(inv: MyInvite): Promise<boolean> {
  if (inviteBusyId() !== null) return false;
  setInviteBusyId(inv.id);
  setInviteError(null);
  try {
    const { server_id } = await central.acceptInvite(inv.id);
    await Promise.all([refreshInvites(), loadServers()]);
    setActiveServer(server_id);
    return true;
  } catch (err) {
    setInviteError(err instanceof ApiError ? err.message : "Could not accept invite");
    void refreshInvites();
    return false;
  } finally {
    setInviteBusyId(null);
  }
}

export async function declineInviteAction(inv: MyInvite): Promise<boolean> {
  if (inviteBusyId() !== null) return false;
  setInviteBusyId(inv.id);
  setInviteError(null);
  try {
    await central.declineInvite(inv.id);
    await refreshInvites();
    return true;
  } catch (err) {
    setInviteError(err instanceof ApiError ? err.message : "Could not decline invite");
    void refreshInvites();
    return false;
  } finally {
    setInviteBusyId(null);
  }
}

export function clearInviteError(): void {
  setInviteError(null);
}
