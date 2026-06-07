-- Core Module: active bans.
-- A user with a row here is banned. Checked during WS auth — banned users
-- cannot connect. Removed on unban; never soft-deleted.

CREATE TABLE IF NOT EXISTS bans (
  user_id   TEXT PRIMARY KEY,
  banned_by TEXT NOT NULL,
  banned_at INTEGER NOT NULL,
  reason    TEXT NOT NULL DEFAULT ''
);
