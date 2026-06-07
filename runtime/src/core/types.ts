// Internal SQLite row types for the Core Module.
// These match the column names exactly; use toUser/toLayout helpers to convert.

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  is_online: number; // 0 | 1
  last_seen_at: number;
  connected_at: number;
}

export interface WorkspaceLayoutRow {
  user_id: string;
  layout_json: string;
  updated_at: number;
}

export interface ServerDefaultLayoutRow {
  id: 1;
  layout_json: string;
  updated_at: number;
  updated_by: string;
}

export interface MemberRow {
  id: string;
  joined_at: number;
}

export interface BanRow {
  user_id: string;
  banned_by: string;
  banned_at: number;
  reason: string;
}

export interface AuditLogRow {
  id: string;
  action: string;
  actor_id: string;
  target_id: string | null;
  details: string;
  created_at: number;
}

export interface SavedWorkspaceRow {
  id: string;
  user_id: string;
  name: string | null;
  layout_json: string;
  created_at: number;
  updated_at: number;
}

export interface BrowserRecentRow {
  user_id: string;
  recent_json: string;
  updated_at: number;
}

export interface CategoryRow {
  id: string;
  name: string;
  position: number;
  created_at: number;
  updated_at: number;
}
