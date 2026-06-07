CREATE TABLE IF NOT EXISTS users (
  id           TEXT    NOT NULL PRIMARY KEY,
  display_name TEXT    NOT NULL DEFAULT '',
  avatar_url   TEXT    NOT NULL DEFAULT '',
  is_online    INTEGER NOT NULL DEFAULT 0 CHECK (is_online IN (0, 1)),
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  connected_at INTEGER NOT NULL DEFAULT 0
);

-- Fast lookup of currently connected users.
CREATE INDEX IF NOT EXISTS idx_users_online ON users (is_online) WHERE is_online = 1;
