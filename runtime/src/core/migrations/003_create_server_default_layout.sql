CREATE TABLE IF NOT EXISTS server_default_layout (
  -- CHECK constraint enforces single-row table.
  id          INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  layout_json TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT    NOT NULL DEFAULT ''
);

-- Seed the platform default: single leaf panel, empty panels map.
-- INSERT OR IGNORE so re-running the migration is idempotent.
INSERT OR IGNORE INTO server_default_layout (id, layout_json, updated_at, updated_by)
VALUES (
  1,
  '{"version":1,"root":{"type":"leaf","id":"default"},"panels":{}}',
  0,
  ''
);
