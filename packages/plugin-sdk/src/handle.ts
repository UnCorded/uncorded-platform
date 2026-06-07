// Request handler registry — dispatches incoming IPC requests to registered handlers.

import type { IpcRequestMessage, ResponseError } from "@uncorded/protocol";
import type { IpcTransport } from "./transport";
import type { RequestHandler } from "./types";
import { requestContext } from "./request-context";

export function createHandlerRegistry(transport: IpcTransport) {
  const handlers = new Map<string, RequestHandler>();

  function register(action: string, handler: RequestHandler): void {
    handlers.set(action, handler);
  }

  async function dispatch(msg: IpcRequestMessage): Promise<void> {
    const handler = handlers.get(msg.action);

    if (!handler) {
      const error: ResponseError = {
        code: "UNKNOWN_ACTION",
        message: `No handler registered for action: ${msg.action}`,
      };
      transport.send({ type: "response", id: msg.id, error });
      return;
    }

    // Establish the request context for the handler's entire async lifetime.
    // sdk.presence.{join,leave,update} read this via getCurrentSession() to
    // attribute presence mutations to the originating WS session.
    try {
      const result = await requestContext.run(
        { session_id: msg.session_id, plugin_request_id: msg.id },
        () => handler(msg.params, msg.user),
      );
      transport.send({ type: "response", id: msg.id, result });
    } catch (err: unknown) {
      const error: ResponseError = {
        code: "HANDLER_ERROR",
        message: err instanceof Error ? err.message : "Unknown handler error",
      };
      transport.send({ type: "response", id: msg.id, error });
    }
  }

  return { register, dispatch };
}
