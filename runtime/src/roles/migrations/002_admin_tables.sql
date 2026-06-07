-- Runtime admin schema: audit log, plugin settings, and cascade wiring rules.

CREATE TABLE plugin_settings (
  slug       TEXT PRIMARY KEY,
  disabled   INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  actor_user_id TEXT    NOT NULL,
  actor_role    TEXT    NOT NULL,
  action        TEXT    NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  payload_json  TEXT    NOT NULL
);

CREATE INDEX idx_audit_log_ts ON audit_log(ts DESC);
CREATE INDEX idx_audit_log_action ON audit_log(action);

CREATE TABLE cascade_rules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_plugin TEXT    NOT NULL,
  event_topic   TEXT    NOT NULL,
  target_plugin TEXT    NOT NULL,
  target_action TEXT    NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_cascade_unique
  ON cascade_rules(source_plugin, event_topic, target_plugin, target_action);

