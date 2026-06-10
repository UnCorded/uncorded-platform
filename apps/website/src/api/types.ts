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
  tunnel_url: string | null;
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
