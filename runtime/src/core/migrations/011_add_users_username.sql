-- Add username column to users cache. Mirrors the Central canonical
-- username (lowercase ASCII, [a-z0-9_]{3,20}) but is just a cache here —
-- WS-auth upserts and heartbeat profile_changed deltas keep it current.
ALTER TABLE users ADD COLUMN username TEXT NOT NULL DEFAULT '';
