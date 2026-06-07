-- spec-24 Amendment A: Voice external reachability state cache.
--
-- A single-row table (id PK CHECK = 1) holding the most recent VoiceProbeResult
-- received from Central. The runtime restores from here on boot so the owner
-- modal and `/health/voice.externalReachability` aren't blank during the
-- first-probe window after a restart.
--
-- We persist the JSON for rtc_tcp / rtc_udp verbatim (including latencyMs and
-- error codes) so the modal can show why a port is down without another
-- round-trip to Central. checked_at is INTEGER epoch-ms — same convention as
-- the rest of the runtime SQLite schema.
--
-- wan_ip is what the probe TARGETED (server's last-known WAN IP). Distinct
-- from the in-memory `last wan_ip echoed by heartbeat` — that one drives the
-- "WAN changed → re-probe" trigger and may briefly diverge from the persisted
-- value during the cooldown gap.
CREATE TABLE IF NOT EXISTS voice_reachability_state (
  id            INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  status        TEXT    NOT NULL CHECK (status IN ('ready', 'unreachable')),
  checked_at    INTEGER NOT NULL,
  wan_ip        TEXT    NOT NULL,
  rtc_tcp_json  TEXT    NOT NULL,
  rtc_udp_json  TEXT    NOT NULL
);
