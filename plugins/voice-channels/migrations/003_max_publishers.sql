-- PR-6 §13: per-channel cap on simultaneous screen-share publishers. Without
-- it, a homelab box gets DOS'd by 50× 2 Mbps publishers (~100 Mbps + 5 cores
-- SFU ingest). Default 10 fits the 20 Mbps + ~1 core budget for a single SFU
-- on consumer hardware. Independent of `max_participants` (the join cap)
-- because most participants in a typical room are listeners, not publishers.

ALTER TABLE channels
  ADD COLUMN max_publishers INTEGER NOT NULL DEFAULT 10
  CHECK (max_publishers BETWEEN 1 AND 99);
