CREATE TABLE IF NOT EXISTS categories (
  id         TEXT    NOT NULL PRIMARY KEY,
  name       TEXT    NOT NULL,
  position   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_categories_position ON categories (position);
