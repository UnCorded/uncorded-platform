// Typed wrapper around the runtime's `/admin/api/plugins/...` surface.
//
// Sits one layer above raw fetch — every call mints a fresh server token via
// `central.getServerToken(serverId)` and translates HTTP errors into a single
// `AdminPluginError` shape so the UI layer stays free of error-decoding noise.

import * as central from "@/api/central";
import type { PluginManifest, PluginSetting } from "@uncorded/shared";

export type PluginStatusLabel = "ready" | "starting" | "stopped" | "quarantined";

export interface AdminPluginRow {
  slug: string;
  manifest: PluginManifest;
  state: string | null;
  statusLabel: PluginStatusLabel;
  enabled: boolean;
  hasSettings: boolean;
}

export interface AdminPluginConfig {
  slug: string;
  settings: PluginSetting[];
  values: Record<string, string | number | boolean>;
}

export class AdminPluginError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function adminFetch(
  serverId: string,
  tunnelUrl: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (!tunnelUrl) {
    throw new AdminPluginError(
      "SERVER_UNREACHABLE",
      "Server has no tunnel URL — bring it online first.",
      0,
    );
  }
  const { token } = await central.getServerToken(serverId);
  const res = await fetch(`${tunnelUrl}/admin/api${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message = `Request failed with ${res.status}.`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      // Body wasn't JSON — keep the generic message.
    }
    throw new AdminPluginError(code, message, res.status);
  }
  return res;
}

export async function listPlugins(
  serverId: string,
  tunnelUrl: string,
): Promise<AdminPluginRow[]> {
  const res = await adminFetch(serverId, tunnelUrl, "/plugins");
  const body = (await res.json()) as { plugins: AdminPluginRow[] };
  return body.plugins;
}

export async function setPluginEnabled(
  serverId: string,
  tunnelUrl: string,
  slug: string,
  enabled: boolean,
): Promise<void> {
  await adminFetch(serverId, tunnelUrl, `/plugins/${slug}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

export async function getPluginConfig(
  serverId: string,
  tunnelUrl: string,
  slug: string,
): Promise<AdminPluginConfig> {
  const res = await adminFetch(serverId, tunnelUrl, `/plugins/${slug}/config`);
  return (await res.json()) as AdminPluginConfig;
}

export async function patchPluginConfig(
  serverId: string,
  tunnelUrl: string,
  slug: string,
  key: string,
  value: string | number | boolean,
): Promise<void> {
  await adminFetch(serverId, tunnelUrl, `/plugins/${slug}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}
