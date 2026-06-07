// Request context — carried through async boundaries via AsyncLocalStorage so
// that nested SDK calls (e.g. sdk.presence.join inside a sdk.handle handler)
// can attribute themselves to the originating WS session.
//
// The context is set by createHandlerRegistry.dispatch() before invoking the
// plugin's handler and remains active for the entire async lifetime of that
// handler — including awaited Promises and microtasks. It is unset for
// timers/intervals/event handlers that escape the handler's async tree, which
// is exactly the failure mode sdk.presence.{join,leave,update} need to detect
// per spec-23 §"Backend SDK Surface — Semantics".

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /**
   * The opaque WS session id that originated the request being handled.
   * `undefined` for runtime-originated requests (schedule.tick, cascade).
   */
  session_id: string | undefined;
  /** The IPC request id, useful for log correlation. */
  plugin_request_id: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Returns the current WS session id if the caller is running inside a
 * sdk.handle() handler triggered by a client-originated request. Returns
 * `undefined` otherwise.
 */
export function getCurrentSession(): string | undefined {
  return requestContext.getStore()?.session_id;
}

/**
 * Returns the full active request context, or `undefined` if there isn't one.
 * Useful for testing and for SDK internals that need both fields.
 */
export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}
