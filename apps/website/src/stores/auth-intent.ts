import { createSignal } from "solid-js";
import { ApiError } from "../api/types";
import { sessionExpired } from "./auth";

// Auth-gate with return-to. When an unauthenticated (or expired) visitor
// tries to do something that needs a Central session — open a ?join=<id>
// deep link, request to join from Explore — the *intent* is stashed here,
// AuthPage is surfaced, and once bootstrap()/login lands the intent replays
// instead of dumping the user on a blank home screen.
//
// Persistence is sessionStorage, not a signal alone: the web OAuth flow
// leaves the page entirely (full redirect to Central and back), so anything
// in-memory dies mid-flow. Survives exactly one browser session — a stale
// "join" from last week should not fire on an unrelated login.

export interface AuthIntent {
  action: "join";
  serverId: string;
}

const STORAGE_KEY = "uncorded.pending-auth-intent";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// In-memory fallback covers non-DOM contexts (tests) and storage-disabled
// browsers; same semantics, just doesn't survive a redirect.
let memoryIntent: AuthIntent | null = null;

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function parseIntent(raw: string | null): AuthIntent | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { action?: unknown; serverId?: unknown };
    if (parsed.action === "join" && typeof parsed.serverId === "string" && UUID_RE.test(parsed.serverId)) {
      return { action: "join", serverId: parsed.serverId };
    }
  } catch {
    // fall through — malformed payloads are dropped, never replayed
  }
  return null;
}

export function setPendingIntent(intent: AuthIntent): void {
  memoryIntent = intent;
  storage()?.setItem(STORAGE_KEY, JSON.stringify(intent));
}

export function peekPendingIntent(): AuthIntent | null {
  const s = storage();
  return (s ? parseIntent(s.getItem(STORAGE_KEY)) : null) ?? memoryIntent;
}

/** Read AND clear — an intent replays at most once. */
export function consumePendingIntent(): AuthIntent | null {
  const intent = peekPendingIntent();
  memoryIntent = null;
  storage()?.removeItem(STORAGE_KEY);
  return intent;
}

/** Validates a raw ?join= param into an intent serverId, or null. */
export function parseJoinParam(value: string | null): string | null {
  return value && UUID_RE.test(value) ? value : null;
}

// The replay target. App.tsx consumes the pending intent once the account
// resolves and routes it here; the join surface (server selector / Explore)
// watches this signal and opens the request-to-join flow for the server.
const [joinTarget, setJoinTarget] = createSignal<string | null>(null);
export { joinTarget, setJoinTarget };

export function clearJoinTarget(): void {
  setJoinTarget(null);
}

/**
 * Run an authenticated action; on 401, stash the intent and surface AuthPage
 * (via the existing sessionExpired teardown). Returns null when gated — the
 * caller's UI simply yields to the login screen, and the intent replays
 * after bootstrap()/login succeeds.
 */
export async function withAuthGate<T>(
  intent: AuthIntent,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setPendingIntent(intent);
      sessionExpired("Sign in to continue.");
      return null;
    }
    throw err;
  }
}
