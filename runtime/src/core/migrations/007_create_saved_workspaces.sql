CREATE TABLE IF NOT EXISTS saved_workspaces (
  id          TEXT    NOT NULL PRIMARY KEY,
  user_id     TEXT    NOT NULL,
  name        TEXT,
  layout_json TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saved_workspaces_user ON saved_workspaces (user_id, created_at);
