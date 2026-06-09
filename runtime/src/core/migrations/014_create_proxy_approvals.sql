-- Reverse-proxy mount approvals (runtime-owned).
-- See docs/reverse-proxy/plugin-reverse-proxy-plan.md §Approval Model.
--
-- A mount is DISABLED until a row exists here (fail closed). Only the admin
-- approve endpoint (Phase 4) creates or refreshes rows; config writes may only
-- invalidate (delete) them. The runtime checks, on every proxy request, that
-- the stored plugin_version / mount_definition_hash / normalized upstream still
-- match the live manifest + setting; any drift means "not approved" (409).
--
-- approval_version is bound into the signed proxy-session cookie. Re-approval
-- bumps it so cookies minted against a prior approval stop validating.
--
-- This table lives in core.db, NOT the plugin's SQLite database: a plugin must
-- never be able to approve its own upstream. Keyed by (plugin_slug, mount_name)
-- — one approval per mount.
CREATE TABLE IF NOT EXISTS proxy_approvals (
  plugin_slug                  TEXT    NOT NULL,
  plugin_version               TEXT    NOT NULL,
  mount_name                   TEXT    NOT NULL,
  mount_definition_hash        TEXT    NOT NULL,
  upstream_setting_key         TEXT    NOT NULL,
  normalized_upstream_origin   TEXT    NOT NULL,
  normalized_upstream_base_path TEXT   NOT NULL,
  approved_by_user_id          TEXT    NOT NULL,
  approved_at                  INTEGER NOT NULL,
  approval_version             INTEGER NOT NULL,
  PRIMARY KEY (plugin_slug, mount_name)
);
