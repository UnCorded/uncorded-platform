// Plugin resource SDK backend dispatch (RP-FOUND-4, plan §8.1).
//
// Runtime-side handlers for the `resources.*` IPC family a plugin calls to manage
// its own resource types, instances, and ACLs, and to ask the resolver an
// authorization question:
//   resources.define  — register a resource type (own plugin only)
//   resources.create  — create a resource instance (own plugin only)
//   resources.grant   — add an `allow` ACL row (own plugin only)
//   resources.revoke  — remove an ACL row (own plugin only)
//   resources.check   — resolver AuthDecision for a viewer + ref + action
//
// SECURITY — two separate authorities, enforced here in this order:
//   1. PLUGIN CALLER capability (this layer). Cross-plugin WRITES are always
//      forbidden (CLAUDE.md: "Cross-plugin writes are forbidden"); cross-plugin
//      READS (`resources.check` on another plugin's resource) require the caller
//      to have declared `resources.read:<owner-plugin>`. Both checks run BEFORE
//      the resolver or any adapter is consulted.
//   2. USER ACL (the resolver). The resolver is the sole authority for
//      user-level allow/deny and knows nothing about plugin callers. It is only
//      reached after (1) passes.
//
// The runtime stamps the caller's slug on every define/create/grant/revoke, so a
// plugin can only ever register / create / mutate ACLs for its OWN resources —
// a client-supplied plugin slug cannot widen that scope.

import { rootLogger } from "@uncorded/shared";
import type {
  IpcMessage,
  IpcTransport,
  PluginResourceAction,
  PluginResourceKey,
  PluginResourceRef,
  PluginResourceTypeRegistration,
  ViewerContext,
} from "@uncorded/protocol";
import {
  PluginResourceActionSchema,
  PluginResourceRefSchema,
  ResourcePrincipalSchema,
} from "@uncorded/protocol-schemas";
import type { PluginResourceStore } from "./store";
import type { PluginResourceResolver } from "./resolver";
import type { CreateResourceInput } from "./types";

const log = rootLogger.child({ component: "plugin-resources-ipc" });

/**
 * Dependencies the dispatch needs. `serverId` is the runtime's own server scope
 * (stamped onto every viewer/key — never caller-supplied). `checkCapability`
 * answers whether the calling plugin declared a capability, backed by its
 * `CapabilityChecker`; it gates cross-plugin reads before the resolver.
 */
export interface PluginResourceIpcDeps {
  store: PluginResourceStore;
  resolver: PluginResourceResolver;
  serverId: string;
  checkCapability: (capability: string) => boolean;
}

// ---------------------------------------------------------------------------
// Response helpers (self-contained — handlers.ts keeps its own copies private)
// ---------------------------------------------------------------------------

function sendResult(transport: IpcTransport, id: string, result: unknown): void {
  transport.send({ type: "response", id, result } as IpcMessage);
}

function sendError(transport: IpcTransport, id: string, code: string, message: string): void {
  transport.send({ type: "response", id, error: { code, message } } as IpcMessage);
}

function requireString(msg: IpcMessage, field: string): string | null {
  const v = msg[field];
  return typeof v === "string" ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function handlePluginResourcesIpc(
  callerSlug: string,
  msg: IpcMessage,
  transport: IpcTransport,
  deps: PluginResourceIpcDeps,
): void {
  const id = requireString(msg, "id");
  if (id === null) {
    log.warn("resources.* request missing string id — dropped", {
      plugin: callerSlug,
      type: typeof msg["type"] === "string" ? (msg["type"] as string) : undefined,
    });
    return;
  }

  const msgType = msg["type"] as string;
  switch (msgType) {
    case "resources.define":
      return handleDefine(callerSlug, msg, transport, deps, id);
    case "resources.create":
      return handleCreate(callerSlug, msg, transport, deps, id);
    case "resources.grant":
      return handleAclWrite("grant", callerSlug, msg, transport, deps, id);
    case "resources.revoke":
      return handleAclWrite("revoke", callerSlug, msg, transport, deps, id);
    case "resources.check":
      return handleCheck(callerSlug, msg, transport, deps, id);
    default:
      sendError(transport, id, "UNKNOWN_RESOURCE_ACTION", `Unknown resources action '${msgType}'.`);
  }
}

// ---------------------------------------------------------------------------
// define — register a resource type (own plugin only)
// ---------------------------------------------------------------------------

function handleDefine(
  callerSlug: string,
  msg: IpcMessage,
  transport: IpcTransport,
  deps: PluginResourceIpcDeps,
  id: string,
): void {
  const registration = msg["registration"];
  if (!isRecord(registration)) {
    sendError(transport, id, "INVALID_PARAMS", "resources.define requires a 'registration' object.");
    return;
  }
  // Stamp the caller's slug; a client-supplied pluginSlug cannot widen scope.
  // The store re-validates the whole shape against the protocol schema and
  // returns INVALID_REGISTRATION on any malformed field.
  const stamped = { ...registration, pluginSlug: callerSlug } as unknown as PluginResourceTypeRegistration;
  const res = deps.store.registerType(stamped);
  if (!res.ok) {
    sendError(transport, id, res.error.code, res.error.message);
    return;
  }
  sendResult(transport, id, { ok: true });
}

// ---------------------------------------------------------------------------
// create — create a resource instance (own plugin only)
// ---------------------------------------------------------------------------

function handleCreate(
  callerSlug: string,
  msg: IpcMessage,
  transport: IpcTransport,
  deps: PluginResourceIpcDeps,
  id: string,
): void {
  const resourceType = requireString(msg, "resourceType");
  const resourceId = requireString(msg, "resourceId");
  if (resourceType === null || resourceId === null) {
    sendError(transport, id, "INVALID_PARAMS", "resources.create requires string 'resourceType' and 'resourceId'.");
    return;
  }

  const input: CreateResourceInput = {
    serverId: deps.serverId,
    pluginSlug: callerSlug,
    resourceType,
    resourceId,
  };

  const parent = msg["parent"];
  if (parent !== undefined) {
    if (!isRecord(parent) || typeof parent["resourceType"] !== "string" || typeof parent["resourceId"] !== "string") {
      sendError(transport, id, "INVALID_PARAMS", "'parent' must be { resourceType, resourceId }.");
      return;
    }
    input.parent = { resourceType: parent["resourceType"], resourceId: parent["resourceId"] };
  }

  const owner = msg["owner"];
  if (owner !== undefined) {
    if (!isRecord(owner) || typeof owner["userId"] !== "string") {
      sendError(transport, id, "INVALID_PARAMS", "'owner' must be { userId }.");
      return;
    }
    input.ownerUserIds = [owner["userId"]];
  }

  const res = deps.store.createResource(input);
  if (!res.ok) {
    sendError(transport, id, res.error.code, res.error.message);
    return;
  }
  const ref: PluginResourceRef = {
    kind: "pluginResource",
    pluginSlug: callerSlug,
    resourceType,
    resourceId,
  };
  sendResult(transport, id, { ref });
}

// ---------------------------------------------------------------------------
// grant / revoke — ACL mutations (own plugin only; cross-plugin writes rejected)
// ---------------------------------------------------------------------------

function handleAclWrite(
  op: "grant" | "revoke",
  callerSlug: string,
  msg: IpcMessage,
  transport: IpcTransport,
  deps: PluginResourceIpcDeps,
  id: string,
): void {
  const refParsed = PluginResourceRefSchema.safeParse(msg["resource"]);
  if (!refParsed.success) {
    sendError(transport, id, "INVALID_PARAMS", "Invalid 'resource' ref.");
    return;
  }
  const ref = refParsed.data;

  // Cross-plugin WRITE hard-reject — BEFORE the store is touched. A plugin may
  // never mutate another plugin's ACLs (CLAUDE.md). This is the plugin-caller
  // authority, distinct from and prior to the resolver's user-ACL authority.
  if (ref.pluginSlug !== callerSlug) {
    sendError(
      transport,
      id,
      "CROSS_PLUGIN_WRITE_FORBIDDEN",
      `Plugin '${callerSlug}' may not mutate ACLs on '${ref.pluginSlug}' resources.`,
    );
    return;
  }

  const actionParsed = PluginResourceActionSchema.safeParse(msg["action"]);
  if (!actionParsed.success) {
    sendError(transport, id, "INVALID_PARAMS", "Invalid 'action'.");
    return;
  }
  const action: PluginResourceAction = actionParsed.data;

  const principalParsed = ResourcePrincipalSchema.safeParse(msg["principal"]);
  if (!principalParsed.success) {
    sendError(transport, id, "INVALID_PARAMS", "Invalid 'principal'.");
    return;
  }
  const principal = principalParsed.data;

  const key: PluginResourceKey = {
    serverId: deps.serverId,
    pluginSlug: callerSlug,
    resourceType: ref.resourceType,
    resourceId: ref.resourceId,
  };

  const res =
    op === "grant"
      ? deps.store.grant(key, principal, action, callerSlug)
      : deps.store.revoke(key, principal, action);
  if (!res.ok) {
    sendError(transport, id, res.error.code, res.error.message);
    return;
  }
  const resource = deps.store.getResource(key);
  sendResult(transport, id, { ok: true, aclVersion: resource?.aclVersion ?? null });
}

// ---------------------------------------------------------------------------
// check — resolver AuthDecision (cross-plugin reads capability-gated)
// ---------------------------------------------------------------------------

function handleCheck(
  callerSlug: string,
  msg: IpcMessage,
  transport: IpcTransport,
  deps: PluginResourceIpcDeps,
  id: string,
): void {
  const userId = requireString(msg, "user_id");
  if (userId === null) {
    sendError(transport, id, "INVALID_PARAMS", "resources.check requires a string 'user_id'.");
    return;
  }
  const refParsed = PluginResourceRefSchema.safeParse(msg["resource"]);
  if (!refParsed.success) {
    sendError(transport, id, "INVALID_PARAMS", "Invalid 'resource' ref.");
    return;
  }
  const ref = refParsed.data;
  const actionParsed = PluginResourceActionSchema.safeParse(msg["action"]);
  if (!actionParsed.success) {
    sendError(transport, id, "INVALID_PARAMS", "Invalid 'action'.");
    return;
  }
  const action: PluginResourceAction = actionParsed.data;

  // Cross-plugin READ gate — BEFORE building the viewer or calling the resolver.
  // Checking another plugin's resource requires a declared capability; an
  // undeclared caller is denied here without the resolver (or any adapter) ever
  // being consulted.
  if (ref.pluginSlug !== callerSlug && !deps.checkCapability(`resources.read:${ref.pluginSlug}`)) {
    sendError(
      transport,
      id,
      "CAPABILITY_DENIED",
      `Plugin '${callerSlug}' must declare 'resources.read:${ref.pluginSlug}' to check '${ref.pluginSlug}' resources.`,
    );
    return;
  }

  const viewer: ViewerContext = { userId, serverId: deps.serverId };
  const decision =
    action === "read"
      ? deps.resolver.canReadPluginResource(viewer, ref)
      : deps.resolver.canPluginResourceAction(viewer, ref, action);
  sendResult(transport, id, decision);
}
