CREATE TABLE channels (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  topic      TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  author_id  TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at  INTEGER
);

CREATE INDEX idx_messages_channel_time ON messages(channel_id, created_at);

-- Seed a default general channel
INSERT INTO channels (id, name, topic, created_at)
VALUES ('00000000-0000-0000-0000-000000000001', 'general', 'General discussion', strftime('%s', 'now') * 1000);
