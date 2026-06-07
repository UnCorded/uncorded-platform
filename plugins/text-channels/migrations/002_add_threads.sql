-- Thread support: a reply is a message with parent_message_id pointing to a root.
-- Roots have parent_message_id IS NULL. Flat only — enforced in backend.
ALTER TABLE messages ADD COLUMN parent_message_id TEXT REFERENCES messages(id);
ALTER TABLE messages ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN last_reply_at INTEGER;

CREATE INDEX idx_messages_parent ON messages(parent_message_id);

-- Self-healing reconciliation: recompute reply_count from actual row state.
-- No-op on empty DB; protects against any future drift from a restored backup
-- or a past transactional failure.
UPDATE messages SET reply_count = (
  SELECT COUNT(*) FROM messages AS c WHERE c.parent_message_id = messages.id
) WHERE parent_message_id IS NULL;
