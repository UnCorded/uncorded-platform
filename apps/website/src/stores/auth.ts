import { createSignal } from "solid-js";
import type { Account } from "../api/types";
import * as central from "../api/central";
import { clearAllTokens } from "../lib/tokens";
import { disconnectAll } from "../lib/ws";

const [account, setAccount] = createSignal<Account | null>(null);
const [authLoading, setAuthLoading] = createSignal(true);
const [authError, setAuthError] = createSignal<string | null>(null);
/**
 * Set when the user's Central session expires or is revoked during an active
 * client session — surfaced as a banner on AuthPage so the user understands
 * why they were kicked back to the login screen. Cleared on successful login.
 */
const [sessionExpiredReason, setSessionExpiredReason] = createSignal<string | null>(null);

/**
 * Generic notice surfaced on AuthPage above the form (e.g. an expired email
 * verification link bouncing the user back to /?error=verify_failed). Distinct
 * from sessionExpiredReason so the wording can be tuned per cause without
 * re-purposing the session-expired banner.
 */
export type AuthNoticeSeverity = "info" | "error";
export interface AuthNotice {
  message: string;
  severity: AuthNoticeSeverity;
}
const [authNotice, setAuthNotice] = createSignal<AuthNotice | null>(null);

export { account, setAccount, authLoading, authError, sessionExpiredReason, authNotice, setAuthNotice };

export async function bootstrap(): Promise<void> {
  setAuthLoading(true);
  try {
    const profile = await central.getProfile();
    setAccount(profile);
  } catch {
    setAccount(null);
  } finally {
    setAuthLoading(false);
  }
}

/** `identifier` is either an email address or a username. */
export async function login(identifier: string, password: string): Promise<void> {
  setAuthError(null);
  try {
    const acc = await central.login(identifier, password);
    setAccount(acc);
    setSessionExpiredReason(null);
    setAuthNotice(null);
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "Login failed. Please try again.";
    setAuthError(msg);
    throw err;
  }
}

export async function loginWithOAuth(provider: "google" | "discord" | "github"): Promise<void> {
  setAuthError(null);
  try {
    const acc = await central.startOAuth(provider);
    setAccount(acc);
    setSessionExpiredReason(null);
    setAuthNotice(null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "OAuth sign-in failed. Please try again.";
    setAuthError(msg);
    throw err;
  }
}

export async function logout(): Promise<void> {
  try {
    await central.logout();
  } finally {
    disconnectAll();
    clearAllTokens();
    setAccount(null);
    setSessionExpiredReason(null);
  }
}

/**
 * Called when an authenticated Central request comes back 401 mid-session
 * (e.g. the refresh timer in ws.ts can no longer mint a new server token).
 * Tears down the active client state and surfaces a banner on AuthPage.
 */
export function sessionExpired(reason: string): void {
  disconnectAll();
  clearAllTokens();
  setAccount(null);
  setSessionExpiredReason(reason);
}

// Module-level signals can't survive HMR. When this module updates, Vite
// invalidates importers individually — but the browser's ES module cache
// keys by URL, and Vite's per-importer transform cache can leave consumers
// pointing at different `?t=` cache-busters of this file. The result is two
// concrete signal instances: login() writes to one, App's <Show> reads from
// the other, and the UI never reacts to setAccount. Force a full reload on
// any HMR update so every importer re-resolves to the same instance.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}
