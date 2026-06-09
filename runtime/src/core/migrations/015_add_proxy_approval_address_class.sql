-- Record the resolved DNS address class at approval time so the HTTP forwarder
-- can require re-approval if a host later drifts to a different class (e.g. a
-- public name that used to resolve loopback now resolves to an RFC1918 host).
-- Nullable: Phase 1-seeded rows and rows approved before this column existed
-- carry NULL, which the forwarder treats as advisory-only (no drift enforcement)
-- until the Phase 4 approve endpoint records a baseline.
ALTER TABLE proxy_approvals ADD COLUMN approved_address_class TEXT;
