// Outbound request client — sends requests to the runtime and tracks pending promises.
//
// The schema-required `sendAndWait` is the only way the SDK talks to the
// runtime. Per-action callers pass a Zod schema that the resolved `result`
// payload is validated against; failures throw SdkProtocolError carrying the
// captured Zod issues so plugin authors can `instanceof` check them. The
// generic `request<T>()` escape hatch keeps the existing user-typed cast for
// "I'm calling another plugin and accept the shape responsibility."

import type { ResponseError } from "@uncorded/protocol";
import { z } from "zod";
import type { IpcTransport, IpcMessage } from "./transport";
import { SdkProtocolError } from "./errors";
import { unknownResult } from "./schemas";

const REQUEST_TIMEOUT_MS = 30_000;

export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createRequestClient(transport: IpcTransport) {
  let counter = 0;
  const pending = new Map<string, PendingRequest>();

  function nextId(): string {
    return `req_${++counter}`;
  }

  /**
   * Send a typed IPC request and wait for the response, validating the
   * result payload against `schema`. A runtime-reported error becomes
   * `SdkProtocolError(error.code, error.message)`. A schema mismatch becomes
   * `SdkProtocolError("invalid_response_shape", ..., { issues })`.
   */
  function sendAndWait<S extends z.ZodTypeAny>(
    schema: S,
    message: IpcMessage,
  ): Promise<z.infer<S>> {
    const id = message.id ?? nextId();
    const msg: IpcMessage = { ...message, id };

    return new Promise<z.infer<S>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new SdkProtocolError("request_timeout", `Request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms`, {
            id,
            type: msg.type,
          }),
        );
      }, REQUEST_TIMEOUT_MS);

      pending.set(id, {
        resolve: (raw: unknown) => {
          const parsed = schema.safeParse(raw);
          if (!parsed.success) {
            reject(
              new SdkProtocolError(
                "invalid_response_shape",
                `Runtime response for ${msg.type} did not match the expected schema`,
                { type: msg.type, issues: parsed.error.issues },
              ),
            );
            return;
          }
          resolve(parsed.data as z.infer<S>);
        },
        reject,
        timer,
      });
      transport.send(msg);
    });
  }

  /**
   * Send a plugin-to-runtime request (action + params). Result shape is
   * caller-typed via `<T>` — no schema validation. Use for cross-plugin calls
   * or runtime services where the per-action result schema isn't useful.
   */
  function request<T = unknown>(
    action: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    return sendAndWait(unknownResult, {
      type: "request",
      action,
      params: params ?? {},
    }) as Promise<T>;
  }

  /** Handle an incoming response message — resolve or reject the pending promise. */
  function handleResponse(msg: IpcMessage): void {
    const id = msg["id"] as string | undefined;
    if (!id) return;

    const entry = pending.get(id);
    if (!entry) return;

    pending.delete(id);
    clearTimeout(entry.timer);

    const error = msg["error"] as ResponseError | undefined;
    if (error) {
      entry.reject(new SdkProtocolError(error.code, error.message));
    } else {
      entry.resolve(msg["result"]);
    }
  }

  return { nextId, sendAndWait, request, handleResponse };
}
