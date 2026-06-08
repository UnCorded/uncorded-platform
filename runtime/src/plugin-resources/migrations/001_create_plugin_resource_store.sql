-- Plugin resource permission foundation store (RP-FOUND-2).
--
-- Core-owned resource identity, ACL metadata, parent links, and version
-- counters for plugin resources. This implements the persistence decision from
-- docs/plugins/resource-permissions-plan.md Open Question §13.1: ACL rows and
-- resource metadata live in core.db (locally readable by the future resolver),
-- while plugin-owned *content* stays in plugin storage.
--
-- IMPORTANT: no plugin content values are stored here. Only identity,
-- structure, ownership metadata, ACL rows, and version counters. There is no
-- resolver/precedence logic in this PR — these tables are the substrate the
-- RP-FOUND-3 resolver reads.
--
-- Lives in core.db alongside the roles and core modules, but is tracked by its
-- own `_plugin_resources_migrations` table (see PluginResourceStore.initialize)
-- so its numbering is independent of the roles and core migration sequences.

-- Registered resource types (plan §4.2). One row per (plugin_slug, type). A
-- runtime container serves a single server, so resource *types* are not
-- server-scoped; resource *instances* below carry the server scope.
CREATE TABLE plugin_resource_types (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_slug            TEXT    NOT NULL,
  type                   TEXT    NOT NULL,
  parent_type            TEXT,
  actions                TEXT    NOT NULL,  -- JSON array of action strings
  inheritable_actions    TEXT    NOT NULL,  -- JSON array (subset of actions)
  action_implications    TEXT,              -- JSON object | NULL
  value_slots            TEXT    NOT NULL,  -- JSON object (slot -> definition)
  producer_value_allowed INTEGER NOT NULL CHECK (producer_value_allowed IN (0, 1)),
  registered_at          INTEGER NOT NULL,
  UNIQUE (plugin_slug, type)
);

-- Resource instances (plan §4.1). Keyed by the full scope tuple. Stores the
-- parent link, owner metadata, version counters, and timestamps — never the
-- protected content values themselves.
CREATE TABLE plugin_resources (
  server_id          TEXT    NOT NULL,
  plugin_slug        TEXT    NOT NULL,
  resource_type      TEXT    NOT NULL,
  resource_id        TEXT    NOT NULL,
  -- Parent link is within the same (server_id, plugin_slug) tree (plan §4.4).
  parent_type        TEXT,
  parent_id          TEXT,
  -- Distance from the tree root (root = 0). Persisted so create-time depth
  -- bounding and re-parent cycle/depth checks are O(1) on the node itself.
  depth              INTEGER NOT NULL DEFAULT 0,
  owner_user_ids     TEXT,              -- JSON array of user ids | NULL
  -- Monotonic ACL version (plan §6.6, §11.1). Bumped on every grant/revoke/deny
  -- and on owner/parent reassignment.
  acl_version        INTEGER NOT NULL DEFAULT 1,
  -- Reserved for the resolver/cache (plan §11.1). Full resolver invalidation
  -- wiring lands in RP-FOUND-3/8; the column exists so that work is additive.
  permission_version INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (server_id, plugin_slug, resource_type, resource_id)
);

CREATE INDEX idx_plugin_resources_parent
  ON plugin_resources (server_id, plugin_slug, parent_type, parent_id);

-- Explicit / registry-seeded ACL rows (plan §6.2). Inherited and registry
-- default decisions are NOT stored here — they are computed at evaluation time
-- by the resolver (plan §4.4, §6.5), which does not exist yet.
--
-- Unused principal columns use sentinels ('' for user, 0 for role) rather than
-- NULL so the UNIQUE constraint reliably collapses to one effect per
-- (resource, principal, action): SQLite treats each NULL as distinct, which
-- would defeat the dedupe.
CREATE TABLE plugin_resource_acl (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id         TEXT    NOT NULL,
  plugin_slug       TEXT    NOT NULL,
  resource_type     TEXT    NOT NULL,
  resource_id       TEXT    NOT NULL,
  principal_kind    TEXT    NOT NULL CHECK (principal_kind IN ('user', 'role', 'everyone', 'owner')),
  principal_user_id TEXT    NOT NULL DEFAULT '',
  principal_role_id INTEGER NOT NULL DEFAULT 0,
  action            TEXT    NOT NULL,
  effect            TEXT    NOT NULL CHECK (effect IN ('allow', 'deny')),
  granted_by        TEXT    NOT NULL,
  granted_at        INTEGER NOT NULL,
  source            TEXT    NOT NULL CHECK (source IN ('explicit', 'registry-seeded')),
  UNIQUE (server_id, plugin_slug, resource_type, resource_id,
          principal_kind, principal_user_id, principal_role_id, action)
);

CREATE INDEX idx_plugin_resource_acl_resource
  ON plugin_resource_acl (server_id, plugin_slug, resource_type, resource_id);
