-- Seed a default "General" voice channel so a freshly-provisioned server has
-- at least one row. Mirrors text-channels' seed in 001_create_tables.sql, with
-- the same fixed UUID pattern (last hex byte differs so the two seeds never
-- collide if a future tool joins them in a single view).
--
-- The shell's sidebar surfaces the per-section "+" (create) affordance from
-- the FIRST item's adminActions, so an empty channels table also hides the
-- create button. Seeding here keeps voice channels at parity with text on
-- first run; admins can rename or delete this row freely.
INSERT INTO channels (id, name, created_at, category_id, position, max_participants, bitrate_kbps, e2ee)
VALUES ('00000000-0000-0000-0000-000000000002', 'General', strftime('%s', 'now') * 1000, NULL, 0, 25, 64, 0);
