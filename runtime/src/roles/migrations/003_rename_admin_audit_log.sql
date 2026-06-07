-- Rename the admin/roles audit log to avoid colliding with the core module's
-- moderation audit log. Both live in core.db. The collision was silent because
-- `CREATE TABLE IF NOT EXISTS audit_log` in the core migration became a no-op
-- once this module had already created a table with the same name (but
-- different schema: ts/actor_user_id/... vs created_at/actor_id/...). Every
-- call to core.audit.list then failed with "no such column: created_at".

ALTER TABLE audit_log RENAME TO admin_audit_log;

-- SQLite keeps auto-indexes attached to the renamed table, but explicitly-
-- named indexes keep their original name and still point at the renamed
-- table. Drop and recreate so index names match the new table name and a
-- future reader isn't misled by `idx_audit_log_ts` on `admin_audit_log`.
DROP INDEX IF EXISTS idx_audit_log_ts;
DROP INDEX IF EXISTS idx_audit_log_action;
CREATE INDEX idx_admin_audit_log_ts ON admin_audit_log(ts DESC);
CREATE INDEX idx_admin_audit_log_action ON admin_audit_log(action);
