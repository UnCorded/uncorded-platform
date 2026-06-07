-- Core Module: moderation audit log.
-- Append-only. Every moderation action writes a row here.
-- action values: 'ban', 'unban', 'kick'
-- details is a JSON object (e.g. { "reason": "spam" }).

CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  action     TEXT NOT NULL,
  actor_id   TEXT NOT NULL,
  target_id  TEXT,
  details    TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
