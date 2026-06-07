// Audit-log writes for the Co-View Sessions subsystem (spec-27 §Audit Log).
// Writes to the existing admin_audit_log table — same row shape as the voice
// cascade audits. Metadata only; never state or pen content.

import type { Database } from "bun:sqlite";

export type CoViewAuditAction =
  | "co_view.session_started"
  | "co_view.session_ended"
  | "co_view.member_joined"
  | "co_view.member_left"
  | "co_view.member_kicked"
  | "co_view.permission_denied"
  | "co_view.update_applied"
  | "co_view.soft_cap_exceeded";

export interface CoViewAuditInput {
  action: CoViewAuditAction;
  /** session_id, or user_id when no session exists yet (permission_denied). */
  targetId: string;
  actorUserId: string | null;
  actorRole?: string;
  payload?: Record<string, unknown>;
}

export function recordCoViewAudit(db: Database, input: CoViewAuditInput): void {
  db.run(
    `INSERT INTO admin_audit_log
     (ts, actor_user_id, actor_role, action, target_type, target_id, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      Date.now(),
      input.actorUserId,
      input.actorRole ?? "system",
      input.action,
      "co_view_session",
      input.targetId,
      JSON.stringify(input.payload ?? {}),
    ],
  );
}
