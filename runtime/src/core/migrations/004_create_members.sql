-- Core Module: join history.
-- One row per user who has ever authenticated on this server.
-- joined_at is the timestamp of first connection; never updated after insert.
-- Profile data (display_name, avatar_url, is_online) lives in the users table.

CREATE TABLE IF NOT EXISTS members (
  id        TEXT PRIMARY KEY,
  joined_at INTEGER NOT NULL
);
