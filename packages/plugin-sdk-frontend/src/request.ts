// Request correlator — sdk.request() over postMessage.
//
// Same ID-correlation pattern as the backend SDK's request client.
// Sends { type: "request", id, plugin: slug, action, params } to the shell.
// Resolves/rejects when { type: "response", id, result/error } arrives.

import { PluginError } from "./errors";

const REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

export function createRequestClient(
  send: (msg: unknown) => void,
  slug: string,
) {
  let counter = 0;
  // Per-iframe prefix. The shell's WebSocket serves many iframes for the same
  // plugin slug (multiple panels bound to the same channel plugin), all
  // sharing one pendingRequests map keyed by request id. Without a per-iframe
  // namespace, two iframes' req_1 collide in the shell — the second overwrites
  // the first, and one iframe hangs until its 30s timeout while the other
  // receives a response meant for its sibling.
  // Per-iframe prefix uses crypto.randomUUID for guaranteed uniqueness across
  // sibling iframes that mount near-simultaneously — Math.random + 8 chars of
  // base36 has a non-negligible birthday-collision probability when many
  // panels open in the same tick.
  const instanceId = crypto.randomUUID();
  const pending = new Map<string, PendingRequest>();

  function request<T = unknown>(
    action: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const id = `req_${instanceId}_${++counter}`;
    const msg = {
      type: "request",
      id,
      plugin: slug,
      action,
      params: params ?? {},
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new PluginError(
            "REQUEST_TIMEOUT",
            `Request "${action}" (${id}) timed out after ${REQUEST_TIMEOUT_MS}ms`,
            { context: { action, id, timeoutMs: REQUEST_TIMEOUT_MS } },
          ),
        );
      }, REQUEST_TIMEOUT_MS);

      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      send(msg);
    });
  }

  function handleResponse(msg: Record<string, unknown>): void {
    const id = msg["id"];
    if (typeof id !== "string") return;

    const entry = pending.get(id);
    if (!entry) return;

    pending.delete(id);
    clearTimeout(entry.timer);

    const error = msg["error"] as { code?: unknown; message?: unknown } | undefined;
    if (error) {
      const code = typeof error.code === "string" ? error.code : "REQUEST_FAILED";
      const message =
        typeof error.message === "string"
          ? error.message
          : `Request "${id}" failed`;
      entry.reject(
        new PluginError(code, message, {
          context: { id, response: msg },
        }),
      );
    } else {
      entry.resolve(msg["result"]);
    }
  }

  return { request, handleResponse };
}
