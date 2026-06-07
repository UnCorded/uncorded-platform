CREATE TABLE IF NOT EXISTS workspace_layouts (
  user_id     TEXT    NOT NULL PRIMARY KEY,
  layout_json TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL
);
