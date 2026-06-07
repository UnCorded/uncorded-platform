-- Voice channels — id-keyed records that the plugin maps onto LiveKit rooms
-- via the runtime bridge. The LiveKit room is auto-created on first join and
-- destroyed on last leave; this table only owns the channel record itself
-- (name, category, defaults).

CREATE TABLE channels (
  id               TEXT    PRIMARY KEY,
  name             TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  -- Soft-FK to core.categories. NULL means "uncategorized" (renders under the
  -- Uncategorized bucket alongside text channels). Cleared via a core.category
  -- .deleted subscription, mirroring text-channels.
  category_id      TEXT,
  -- Stable order within a category bucket. Drag-to-reorder rewrites this.
  position         INTEGER NOT NULL DEFAULT 0,
  -- spec-24 §Bounds: hard cap 99, default 25.
  max_participants INTEGER NOT NULL DEFAULT 25 CHECK (max_participants BETWEEN 1 AND 99),
  -- spec-24 §Bounds: range 8–256 kbps, default 64.
  bitrate_kbps     INTEGER NOT NULL DEFAULT 64 CHECK (bitrate_kbps BETWEEN 8 AND 256),
  -- Per-room E2EE — when set, future recording/transcription plugins MUST
  -- refuse. Stored 0/1; surfaced as boolean to API consumers.
  e2ee             INTEGER NOT NULL DEFAULT 0 CHECK (e2ee IN (0, 1))
);

CREATE INDEX idx_channels_category_position ON channels(category_id, position);
