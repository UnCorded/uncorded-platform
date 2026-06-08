// Authoritative list of tables that MUST exist in core.db after all
// migrations (roles + core) have run. Consumed by assertExpectedTables()
// during boot. If any of these are missing the runtime refuses to accept
// connections — a half-migrated server cannot silently lose audit rows or
// permission state.
//
// Per spec-22-core-module.md Amendment B, "Fail-fast migration assertion".
//
// When adding a new table to runtime/src/core/migrations/,
// runtime/src/roles/migrations/, or runtime/src/plugin-resources/migrations/,
// append its name here. The list is sorted by subsystem to keep diffs readable.

export const EXPECTED_TABLES: readonly string[] = [
  // Roles subsystem (runtime/src/roles/migrations/)
  "roles",
  "user_roles",
  "permissions",
  "role_permissions",
  "admin_audit_log",
  "plugin_settings",
  "cascade_rules",
  "permission_audit",

  // Core module (runtime/src/core/migrations/)
  "users",
  "members",
  "bans",
  "audit_log",
  "workspace_layouts",
  "server_default_layout",
  "saved_workspaces",
  "browser_recent",
  "categories",
  "voice_config",
  "voice_reachability_state",

  // Plugin resource store (runtime/src/plugin-resources/migrations/)
  "plugin_resource_types",
  "plugin_resources",
  "plugin_resource_acl",
] as const;
