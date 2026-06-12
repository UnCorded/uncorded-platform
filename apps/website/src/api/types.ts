export interface Account {
  id: string;
  email: string;
  username: string;
  /** ISO-8601 timestamp of the last username change, or null if never renamed. */
  username_changed_at: string | null;
  /** ISO-8601 timestamp at which the cooldown ends, or null if a rename is currently allowed. */
  username_change_available_at: string | null;
  display_name: string;
  avatar_url: string | null;
  email_verified: boolean;
  phone_verified: boolean;
  providers?: string[];
}

export interface Server {
  id: string;
  name: string;
  description: string | null;
  visibility: "public" | "private";
  owner_id: string;
  /** Resolved client-side from the token mint (Central's list/get responses
   *  no longer carry the URL — it is a membership capability bundled with the
   *  join token). null until the first token for this server is minted. */
  tunnel_url: string | null;
  /** Membership role from /v1/me/servers — absent on directory rows. */
  role?: "owner" | "member";
  /** Membership joined_at from /v1/me/servers — absent on directory rows. */
  joined_at?: string;
  /**
   * Tunnel lifecycle reported by the runtime heartbeat: "demo" (ephemeral quick
   * tunnel), "named" (stable authenticated tunnel), "local" (no public tunnel),
   * or "expired" (a demo tunnel killed at its 24h TTL). null until the first
   * heartbeat carries it. Drives the temp-URL banner and expired-restart gate.
   */
  tunnel_state: "demo" | "named" | "local" | "expired" | null;
  runtime_version: string | null;
  connected_users: number;
  plugin_count: number;
  is_online: boolean;
  last_heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
}

// --- Central membership surfaces (invites, join requests, access list) ---

export interface MyInvite {
  id: string;
  server_id: string;
  server_name: string;
  invited_by_username: string;
  created_at: string;
  expires_at: string;
}

export interface ServerInvite {
  id: string;
  invited_account_id: string;
  username: string;
  display_name: string;
  created_at: string;
  expires_at: string;
}

export interface JoinRequest {
  id: string;
  account_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  created_at: string;
}

/** A Central access-membership row — who may mint tokens for the server.
 *  Distinct from the runtime core module's presence members. */
export interface ServerMember {
  account_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  role: "owner" | "member";
  status: "active" | "banned";
  joined_at: string;
}

export interface Plugin {
  slug: string;
  name: string;
  description: string;
  category: string;
  trust_tier: "official" | "verified" | "community";
  latest_version: string | null;
  install_count: number;
  avg_rating: number | null;
  rating_count: number;
  price: null;
  updated_at: string;
}

export interface PluginDetail extends Plugin {
  id: string;
  long_description: string | null;
  created_at: string;
  publisher: {
    id: string;
    display_name: string;
    avatar_url: string | null;
  } | null;
  versions: Array<{
    id: string;
    version: string;
    api_version_range: string;
    changelog: string | null;
    package_url: string | null;
    package_size_bytes: number | null;
    created_at: string;
  }>;
}

export interface AvatarUploadUrl {
  upload_url: string;
  /** Form fields (key, policy, signature, ...) that must be POSTed alongside
   *  the file. Building a FormData is mandatory — the upload won't authorize
   *  without these. */
  upload_fields: Record<string, string>;
  final_url: string;
  expires_in: number;
  /** Hard cap enforced by R2 via the presigned policy. The shell should
   *  reject larger files before requesting the URL so the user gets a
   *  friendly error rather than an opaque R2 4xx. */
  max_bytes: number;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
