-- Soft FK to core.categories(id) — text-channels has its own SQLite database,
-- so referential integrity is enforced at the application layer:
--   - On create/update: validate the id via sdk.core.listCategories() before write.
--   - On core.category.deleted: subscribe and NULL out matching channels here.
ALTER TABLE channels ADD COLUMN category_id TEXT;
ALTER TABLE channels ADD COLUMN position    INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_channels_category ON channels (category_id, position);
