-- UnCorded Central database schema
-- PostgreSQL 15+

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  -- Stable handle used for login (alongside email) and @-mentions. Always
  -- stored lowercase. Charset enforced in app code (apps/central/src/usernames.ts).
  -- 30-day rename cooldown enforced via username_changed_at; see spec-06.
  username TEXT NOT NULL,
  -- NULL means the user has never renamed since the migration backfill, so
  -- the first claim is free (no cooldown burned). Subsequent renames stamp
  -- this column and must respect the 30-day window.
  username_changed_at TIMESTAMPTZ,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  google_id TEXT UNIQUE,
  discord_id TEXT UNIQUE,
  github_id TEXT UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  phone_verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Username uniqueness is case-insensitive. Always look up via LOWER(username).
CREATE UNIQUE INDEX accounts_username_lower_idx ON accounts (LOWER(username));

-- Sliding session window: the session is valid as long as both deadlines are
-- in the future. idle_expires_at is bumped on use (rate-limited to roughly
-- once an hour per session in middleware.ts to avoid hot-row writes).
-- absolute_expires_at is set at createSession and never touched, capping the
-- total session lifetime regardless of activity.
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  idle_expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_account_id ON sessions(account_id);
CREATE INDEX idx_sessions_idle_expires_at ON sessions(idle_expires_at);

CREATE TABLE signing_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_key TEXT NOT NULL,
  private_key_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  state VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (state IN ('pending', 'active', 'retiring', 'expired'))
);

-- Server directory

CREATE TABLE servers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  owner_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  server_secret_hash TEXT NOT NULL,
  tunnel_url TEXT,
  -- Tunnel lifecycle as reported by the runtime heartbeat: 'demo' (ephemeral
  -- quick tunnel), 'named' (stable authenticated tunnel), 'local' (no public
  -- tunnel), or 'expired' (a demo tunnel that hit its 24h TTL and was killed).
  -- NULL until the first heartbeat that carries it. Directory listings exclude
  -- 'expired'; clients surface a banner/restart gate off this value.
  tunnel_state TEXT,
  runtime_version TEXT,
  connected_users INT NOT NULL DEFAULT 0,
  plugin_count INT NOT NULL DEFAULT 0,
  is_online BOOLEAN NOT NULL DEFAULT false,
  last_heartbeat_at TIMESTAMPTZ,
  -- spec-24 Amendment A — captured from cf-connecting-ip on each heartbeat;
  -- used as the target IP for the voice-reachability probe so a client cannot
  -- direct Central to probe an arbitrary address.
  last_heartbeat_ip TEXT,
  voice_reachability JSONB,
  voice_reachability_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_servers_owner_id ON servers(owner_id);
CREATE INDEX idx_servers_visibility_online ON servers(visibility, is_online);

-- Heartbeat sync tracking

CREATE TABLE server_sync (
  server_id UUID PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  sync_version INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE server_deltas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  sync_version INT NOT NULL,
  delta_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_server_deltas_server_version ON server_deltas(server_id, sync_version);

-- Email verification tokens

CREATE TABLE email_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_verifications_account_id ON email_verifications(account_id);
CREATE INDEX idx_email_verifications_expires_at ON email_verifications(expires_at);

-- Server ownership transfers (two-sided email-confirmation flow)
--
-- Each row is one in-flight transfer. Both parties hold separate hashed tokens
-- and confirm independently; only when both *_confirmed_at columns are set
-- does servers.owner_id actually move (in a single transaction together with
-- flipping is_pending=false). Declines and the periodic expiry sweep also
-- flip is_pending=false. Rows are kept after they're settled — they double as
-- an audit trail for "who initiated/confirmed this transfer when."
--
-- The is_pending boolean exists so we can put a partial unique index on
-- (server_id) WHERE is_pending = true. Postgres rejects mutable functions
-- (now()) inside index predicates, so we can't write `WHERE expires_at >
-- now()` directly — the boolean column gives us the same "currently blocking"
-- semantics in a way the planner accepts.

CREATE TABLE server_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  from_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  from_token_hash TEXT NOT NULL,
  to_token_hash TEXT NOT NULL,
  from_confirmed_at TIMESTAMPTZ,
  to_confirmed_at TIMESTAMPTZ,
  is_pending BOOLEAN NOT NULL DEFAULT true,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_server_transfers_one_pending_per_server
  ON server_transfers(server_id) WHERE is_pending = true;
CREATE INDEX idx_server_transfers_from_token ON server_transfers(from_token_hash);
CREATE INDEX idx_server_transfers_to_token ON server_transfers(to_token_hash);
CREATE INDEX idx_server_transfers_pending_expires
  ON server_transfers(expires_at) WHERE is_pending = true;

-- Plugin marketplace

CREATE TABLE plugins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  long_description TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  trust_tier TEXT NOT NULL DEFAULT 'community'
    CHECK (trust_tier IN ('official', 'verified', 'community')),
  publisher_id UUID NOT NULL REFERENCES accounts(id),
  latest_version TEXT,
  install_count INT NOT NULL DEFAULT 0,
  is_listed BOOLEAN NOT NULL DEFAULT true,
  price NUMERIC(10,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_plugins_trust_tier ON plugins(trust_tier);
CREATE INDEX idx_plugins_listed ON plugins(is_listed);
CREATE INDEX idx_plugins_install_count ON plugins(install_count DESC);
CREATE INDEX idx_plugins_slug ON plugins(slug);

CREATE TABLE plugin_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id UUID NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  api_version_range TEXT NOT NULL,
  changelog TEXT,
  package_url TEXT,
  package_size_bytes INT,
  -- SHA-256 of the uploaded package (64 lowercase hex chars). Returned on
  -- download so the runtime verifies integrity before executing plugin code.
  -- Nullable only to keep legacy pre-hash rows (if any) readable.
  package_sha256 TEXT CHECK (package_sha256 IS NULL OR package_sha256 ~ '^[0-9a-f]{64}$'),
  is_revoked BOOLEAN NOT NULL DEFAULT false,
  revoke_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plugin_id, version)
);

CREATE INDEX idx_plugin_versions_plugin_id ON plugin_versions(plugin_id);

CREATE TABLE plugin_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id UUID NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plugin_id, account_id)
);

CREATE INDEX idx_plugin_ratings_plugin_id ON plugin_ratings(plugin_id);

CREATE TABLE reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES accounts(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('plugin', 'server')),
  target_id UUID NOT NULL,
  target_slug TEXT,
  reason TEXT NOT NULL CHECK (reason IN (
    'malicious_code', 'misleading_description',
    'broken_functionality', 'inappropriate_content', 'other'
  )),
  evidence TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'reviewed', 'actioned', 'dismissed')),
  reviewer_id UUID REFERENCES accounts(id),
  reviewer_notes TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reports_status ON reports(status);
CREATE INDEX idx_reports_target ON reports(target_type, target_id);
CREATE INDEX idx_reports_reporter ON reports(reporter_id);
