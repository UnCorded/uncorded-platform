// IPC dispatch surface for the scoped presence module.
//
// Called from MessageRouter.attachPlugin's IPC switch when msgType starts with
// "presence.". Capability gating (broadcast.clients) happens BEFORE this is
// invoked, via the existing FIXED_CAPABILITY → CapabilityChecker path in the
// router. This module only translates wire shapes ↔ module calls and writes
// the IpcResponse.

import type { IpcMessage } from "../ipc/transport";
import type { StdioParentTransport } from "../ipc/transport";
import type { ScopedPresenceModule } from "./module";
import { PRESENCE_ERROR_CODES, type PresenceError } from "./types";

export function handlePresenceIpc(
  callerSlug: string,
  msg: IpcMessage,
  transport: StdioParentTransport,
  module: ScopedPresenceModule,
): void {
  const id = msg["id"];
  if (typeof id !== "string") {
    // No correlation id → no response can be routed. Silently drop; the SDK
    // would never send a presence call without an id, so this is malformed.
    return;
  }

  const type = msg["type"] as string;
  switch (type) {
    case "presence.join":
      dispatchJoin(callerSlug, id, msg, transport, module);
      return;
    case "presence.leave":
      dispatchLeave(callerSlug, id, msg, transport, module);
      return;
    case "presence.update":
      dispatchUpdate(callerSlug, id, msg, transport, module);
      return;
    case "presence.list":
      dispatchList(callerSlug, id, msg, transport, module);
      return;
    default:
      replyError(transport, id, {
        code: PRESENCE_ERROR_CODES.UNAVAILABLE,
        message: `Unknown presence IPC type "${type}".`,
      });
      return;
  }
}

function dispatchJoin(
  callerSlug: string,
  id: string,
  msg: IpcMessage,
  transport: StdioParentTransport,
  module: ScopedPresenceModule,
): void {
  const fields = readFields(msg, ["scope", "user_id", "session_id"]);
  if (!fields.ok) {
    replyError(transport, id, fields.error);
    return;
  }
  const meta = msg["meta"];
  if (meta !== undefined && (typeof meta !== "object" || meta === null || Array.isArray(meta))) {
    replyError(transport, id, {
      code: PRESENCE_ERROR_CODES.META_TOO_LARGE,
      message: "meta must be a plain object or omitted.",
    });
    return;
  }

  const result = module.join(
    callerSlug,
    fields.value.scope,
    fields.value.user_id,
    fields.value.session_id,
    meta as Record<string, unknown> | undefined,
  );
  if (!result.ok) {
    replyError(transport, id, result.error);
    return;
  }
  reply(transport, id, result.value);
}

function dispatchLeave(
  callerSlug: string,
  id: string,
  msg: IpcMessage,
  transport: StdioParentTransport,
  module: ScopedPresenceModule,
): void {
  const fields = readFields(msg, ["scope", "user_id", "session_id"]);
  if (!fields.ok) {
    replyError(transport, id, fields.error);
    return;
  }
  const result = module.leave(
    callerSlug,
    fields.value.scope,
    fields.value.user_id,
    fields.value.session_id,
  );
  if (!result.ok) {
    replyError(transport, id, result.error);
    return;
  }
  reply(transport, id, null);
}

function dispatchUpdate(
  callerSlug: string,
  id: string,
  msg: IpcMessage,
  transport: StdioParentTransport,
  module: ScopedPresenceModule,
): void {
  const fields = readFields(msg, ["scope", "user_id", "session_id"]);
  if (!fields.ok) {
    replyError(transport, id, fields.error);
    return;
  }
  const meta = msg["meta"];
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    replyError(transport, id, {
      code: PRESENCE_ERROR_CODES.META_TOO_LARGE,
      message: "meta must be a plain object.",
    });
    return;
  }
  const result = module.update(
    callerSlug,
    fields.value.scope,
    fields.value.user_id,
    fields.value.session_id,
    meta as Record<string, unknown>,
  );
  if (!result.ok) {
    replyError(transport, id, result.error);
    return;
  }
  reply(transport, id, null);
}

function dispatchList(
  callerSlug: string,
  id: string,
  msg: IpcMessage,
  transport: StdioParentTransport,
  module: ScopedPresenceModule,
): void {
  const scope = msg["scope"];
  if (typeof scope !== "string") {
    replyError(transport, id, {
      code: PRESENCE_ERROR_CODES.SCOPE_INVALID,
      message: "scope must be a string.",
    });
    return;
  }
  const result = module.list(callerSlug, scope);
  if (!result.ok) {
    replyError(transport, id, result.error);
    return;
  }
  reply(transport, id, result.value);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ReadResult<K extends string> =
  | { ok: true; value: Record<K, string> }
  | { ok: false; error: PresenceError };

function readFields<K extends string>(
  msg: IpcMessage,
  keys: readonly K[],
): ReadResult<K> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = msg[k];
    if (typeof v !== "string" || v.length === 0) {
      return {
        ok: false,
        error: {
          code: PRESENCE_ERROR_CODES.SCOPE_INVALID,
          message: `presence IPC missing required string field "${k}".`,
        },
      };
    }
    out[k] = v;
  }
  return { ok: true, value: out as Record<K, string> };
}

function reply(
  transport: StdioParentTransport,
  id: string,
  result: unknown,
): void {
  transport.send({ type: "response", id, result } as IpcMessage);
}

function replyError(
  transport: StdioParentTransport,
  id: string,
  error: PresenceError,
): void {
  transport.send({
    type: "response",
    id,
    error: { code: error.code, message: error.message },
  } as IpcMessage);
}
