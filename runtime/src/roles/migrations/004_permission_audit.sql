-- Dedicated audit log for permission grants/denies/removes.
--
-- Why a separate table from admin_audit_log: the existing admin_audit_log
-- captures generic role-management actions with a free-form payload_json.
-- Permission overrides are sensitive enough that compliance/incident review
-- wants a stable, queryable schema (target_role_id, permission key, action)
-- rather than JSON spelunking. Splitting also lets us prune retention
-- independently — permission overrides change rarely and we want a long tail.

CREATE TABLE permission_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  actor_user_id  TEXT    NOT NULL,
  target_role_id INTEGER,
  permission     TEXT    NOT NULL,
  action         TEXT    NOT NULL CHECK (action IN ('grant', 'deny', 'remove')),
  reason         TEXT
);

CREATE INDEX idx_permission_audit_ts ON permission_audit(ts DESC);
CREATE INDEX idx_permission_audit_role ON permission_audit(target_role_id);
