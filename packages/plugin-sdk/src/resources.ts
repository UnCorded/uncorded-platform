// Plugin resource SDK surface (RP-FOUND-4) — wraps the `resources.*` IPC family.
//
// A plugin uses this to register its resource types, create instances, manage
// ACLs on its OWN resources, and ask the runtime resolver an authorization
// question. The runtime is the authority: it stamps the calling plugin's slug on
// every define/create/grant/revoke (a plugin can only ever touch its own
// resources), and `check` returns the resolver's `AuthDecision` unchanged.
//
// Cross-plugin access is enforced runtime-side, not here: a `check` against
// another plugin's resource requires the caller to have declared
// `resources.read:<owner-plugin>`, and grant/revoke against another plugin's
// resource is rejected (`CROSS_PLUGIN_WRITE_FORBIDDEN`) — both surface as a
// rejected promise (`SdkProtocolError`).

import type {
  AuthDecision,
  PluginResourceAction,
  PluginResourceRef,
  PluginResourceTypeRegistration,
  ResourcePrincipal,
} from "@uncorded/protocol";
import type { createRequestClient } from "./request";
import type { ResourcesApi } from "./types";
import {
  ResourceAclWriteResult,
  ResourceCheckResult,
  ResourceCreateResult,
  ResourceDefineResult,
} from "./schemas";

export function createResourcesApi(
  client: ReturnType<typeof createRequestClient>,
): ResourcesApi {
  async function define(
    // `pluginSlug` is stamped by the runtime from the caller — never sent.
    registration: Omit<PluginResourceTypeRegistration, "pluginSlug">,
  ): Promise<void> {
    await client.sendAndWait(ResourceDefineResult, {
      type: "resources.define",
      registration,
    });
  }

  async function create(input: {
    resourceType: string;
    resourceId: string;
    parent?: { resourceType: string; resourceId: string };
    owner?: { userId: string };
  }): Promise<PluginResourceRef> {
    const result = await client.sendAndWait(ResourceCreateResult, {
      type: "resources.create",
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      ...(input.parent !== undefined ? { parent: input.parent } : {}),
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
    });
    return result.ref;
  }

  async function grant(
    resource: PluginResourceRef,
    principal: ResourcePrincipal,
    action: PluginResourceAction,
  ): Promise<{ aclVersion: number | null }> {
    const result = await client.sendAndWait(ResourceAclWriteResult, {
      type: "resources.grant",
      resource,
      principal,
      action,
    });
    return { aclVersion: result.aclVersion };
  }

  async function revoke(
    resource: PluginResourceRef,
    principal: ResourcePrincipal,
    action: PluginResourceAction,
  ): Promise<{ aclVersion: number | null }> {
    const result = await client.sendAndWait(ResourceAclWriteResult, {
      type: "resources.revoke",
      resource,
      principal,
      action,
    });
    return { aclVersion: result.aclVersion };
  }

  async function check(
    userId: string,
    resource: PluginResourceRef,
    action: PluginResourceAction,
  ): Promise<AuthDecision> {
    return client.sendAndWait(ResourceCheckResult, {
      type: "resources.check",
      user_id: userId,
      resource,
      action,
    });
  }

  return { define, create, grant, revoke, check };
}
