CREATE TABLE IF NOT EXISTS browser_recent (
  user_id     TEXT    NOT NULL PRIMARY KEY,
  recent_json TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL
);
