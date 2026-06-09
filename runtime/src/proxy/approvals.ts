// Runtime-owned reverse-proxy approval store.
//
// Approvals live in core.db (NOT the plugin's SQLite) so a plugin can never
// approve its own upstream. A mount with no row here is DISABLED (fail closed).
// The admin approve endpoint (Phase 4) is the only writer that CREATES rows;
// config changes may only INVALIDATE (delete) them. See
// docs/reverse-proxy/plugin-reverse-proxy-plan.md §Approval Model.

import type { Database } from "bun:sqlite";
import type { ProxyMount } from "@uncorded/shared";

/** A persisted approval row. Mirrors the proxy_approvals table columns. */
export interface ProxyApprovalRow {
  plugin_slug: string;
  plugin_version: string;
  mount_name: string;
  mount_definition_hash: string;
  upstream_setting_key: string;
  normalized_upstream_origin: string;
  normalized_upstream_base_path: string;
  approved_by_user_id: string;
  approved_at: number;
  approval_version: number;
  /**
   * DNS address class resolved at approval time (see proxy/dns.ts). NULL when no
   * baseline was recorded — the forwarder then treats classification as advisory.
   */
  approved_address_class: string | null;
}

/**
 * Fields supplied when creating/refreshing an approval; the store assigns
 * approval_version. `approved_address_class` is optional and defaults to NULL so
 * callers that don't classify (Phase 1 seeds) need not supply it.
 */
export type ProxyApprovalInput = Omit<ProxyApprovalRow, "approval_version" | "approved_address_class"> & {
  approved_address_class?: string | null;
};

/**
 * Stable hash of a mount's definition. Bound into the approval row so a manifest
 * edit to the mount (rename of the backing setting, access change) invalidates
 * the prior approval — a changed hash no longer matches the stored one.
 */
export function mountDefinitionHash(mount: ProxyMount): string {
  const canonical = JSON.stringify({
    name: mount.name,
    upstream_setting: mount.upstream_setting,
    access: mount.access ?? "members",
  });
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonical);
  return hasher.digest("hex");
}

export class ProxyApprovalStore {
  constructor(private readonly db: Database) {}

  /** Returns the approval for a mount, or null if none (i.e. the mount is disabled). */
  get(pluginSlug: string, mountName: string): ProxyApprovalRow | null {
    const row = this.db
      .query("SELECT * FROM proxy_approvals WHERE plugin_slug = ? AND mount_name = ?")
      .get(pluginSlug, mountName) as ProxyApprovalRow | null;
    return row ?? null;
  }

  /**
   * Create or refresh an approval. Used by the Phase 4 approve endpoint and by
   * tests that seed approvals directly. Re-approving an existing mount bumps
   * approval_version so previously-minted proxy-session cookies stop validating.
   */
  upsert(input: ProxyApprovalInput): ProxyApprovalRow {
    const existing = this.get(input.plugin_slug, input.mount_name);
    const approvalVersion = existing ? existing.approval_version + 1 : 1;
    const addressClass = input.approved_address_class ?? null;
    this.db
      .query(
        `INSERT INTO proxy_approvals (
           plugin_slug, plugin_version, mount_name, mount_definition_hash,
           upstream_setting_key, normalized_upstream_origin, normalized_upstream_base_path,
           approved_by_user_id, approved_at, approval_version, approved_address_class
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(plugin_slug, mount_name) DO UPDATE SET
           plugin_version = excluded.plugin_version,
           mount_definition_hash = excluded.mount_definition_hash,
           upstream_setting_key = excluded.upstream_setting_key,
           normalized_upstream_origin = excluded.normalized_upstream_origin,
           normalized_upstream_base_path = excluded.normalized_upstream_base_path,
           approved_by_user_id = excluded.approved_by_user_id,
           approved_at = excluded.approved_at,
           approval_version = excluded.approval_version,
           approved_address_class = excluded.approved_address_class`,
      )
      .run(
        input.plugin_slug,
        input.plugin_version,
        input.mount_name,
        input.mount_definition_hash,
        input.upstream_setting_key,
        input.normalized_upstream_origin,
        input.normalized_upstream_base_path,
        input.approved_by_user_id,
        input.approved_at,
        approvalVersion,
        addressClass,
      );
    return { ...input, approval_version: approvalVersion, approved_address_class: addressClass };
  }

  /**
   * Invalidate (delete) any approval for this plugin whose upstream setting key
   * matches `settingKey`. Called from the config-write path when an admin
   * changes a setting that backs a mount. Returns the number of rows removed.
   */
  invalidateBySettingKey(pluginSlug: string, settingKey: string): number {
    const result = this.db
      .query("DELETE FROM proxy_approvals WHERE plugin_slug = ? AND upstream_setting_key = ?")
      .run(pluginSlug, settingKey);
    return Number(result.changes);
  }

  /** Remove a single mount's approval. */
  deleteMount(pluginSlug: string, mountName: string): void {
    this.db
      .query("DELETE FROM proxy_approvals WHERE plugin_slug = ? AND mount_name = ?")
      .run(pluginSlug, mountName);
  }

  /** Remove every approval for a plugin (e.g. on uninstall). Returns rows removed. */
  deletePlugin(pluginSlug: string): number {
    const result = this.db
      .query("DELETE FROM proxy_approvals WHERE plugin_slug = ?")
      .run(pluginSlug);
    return Number(result.changes);
  }
}
