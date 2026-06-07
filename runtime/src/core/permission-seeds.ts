// Core named-permissions seeded at boot.
//
// These are platform-built-in permissions registered under the synthetic
// plugin slug "core". Plugins register their own via the rolesEngine
// `registerPermission` API; this file is only for permissions the runtime
// itself needs (e.g. category management surfaced on the WS client API).
//
// Seeding semantics: INSERT OR IGNORE — never overwrite an existing row.
// Once the runtime ships, an admin may have lowered/raised default_level or
// granted explicit per-role overrides. Re-running boot must NOT clobber
// those decisions; if we ever need to bump a default we'll do it via an
// explicit migration rather than silent re-seed.
//
// This is deliberately separate from `RolesEngine.registerPermission`,
// which UPDATEs description/default_level on conflict — appropriate for
// plugins (versioned, can be reinstalled) but wrong for platform defaults.

import type { Database } from "bun:sqlite";

export interface CorePermissionSeed {
  description: string;
  default_level: number;
}

export const CORE_PLUGIN_SLUG = "core";

export const CORE_PERMISSIONS: Readonly<Record<string, CorePermissionSeed>> = {
  "core.categories.manage": {
    description: "Create, update, delete, and reorder server categories.",
    default_level: 80,
  },
  "core.permissions.manage": {
    description: "Create and edit roles, assign member roles, and manage role permission overrides.",
    default_level: 100,
  },
  "core.runtime.update": {
    description:
      "Drive the runtime update lifecycle (check, install, rollback) from the orchestrator. Owner + admin by default; the action button only renders on the orchestrator client AND when this permission is held.",
    // 80 per Phase 01 D5: owner-only is too restrictive for healthy ops
    // (admins are why the role exists), member-accessible is unsafe
    // (mid-day forced-update DOS is a bad failure mode). Visibility of the
    // pill is universal regardless of permission (D4) — only the install
    // action is gated.
    default_level: 80,
  },
  "co-view.host": {
    description:
      "Start a Co-View session that streams the host's UnCorded shell state to invited viewers. Spec-27 §Authorization Model: default off — owner explicitly grants. Joining a session needs no permission; only hosting is gated.",
    // Default off (level 100, owner-only-by-default per the role table —
    // owners hold every permission implicitly). The grant is an explicit
    // owner act per spec; we do NOT auto-grant to admins because Co-View
    // exposes the host's view of the shell (including admin-only chrome to
    // any invited viewer in `as-host` mode), and the owner should pick the
    // small set of users who can broadcast that.
    default_level: 100,
  },
  "co-view.moderate": {
    description:
      "Kick any user from any active Co-View session on this server (server-admin 'stop this Co-View' action). Spec-27 §Authorization Model. Hosts can always kick from their own sessions without this.",
    default_level: 80,
  },
} as const;

export function seedCorePermissions(db: Database): void {
  const now = Date.now();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO permissions (key, description, default_level, plugin_slug, registered_at) VALUES (?, ?, ?, ?, ?)",
  );
  const tx = db.transaction(() => {
    for (const [key, seed] of Object.entries(CORE_PERMISSIONS)) {
      insert.run(key, seed.description, seed.default_level, CORE_PLUGIN_SLUG, now);
    }
  });
  tx();
}
