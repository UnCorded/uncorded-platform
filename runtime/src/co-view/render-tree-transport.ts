// Runtime render-tree transport path for Co-View (CV-FOUND-4b).
//
// This is the transport *capability* that can carry a host's canonical render
// frame to viewers as per-viewer projected frames (`docs/coview/foundation-plan.md`
// §4.6). It wires the already-shipped pieces together at the live dispatch layer:
//
//   host canonical frame  ->  CV-FOUND-2 projector (per viewer)  ->  viewer wire
//
//   control visibility = host permissions   (controls/buttons/menus mirror as-is)
//   data visibility     = viewer permissions (data-bearing values project per viewer)
//
// DISABLED BY DEFAULT. The whole path is gated behind
// `CO_VIEW_RENDER_TREE_TRANSPORT_ENABLED` (false) AND the presence of injected
// transport wiring (`ctx.deps.renderTreeTransport`). Production boot supplies
// neither, so a `co-view.render-tree.frame` is dropped before it touches any
// session state and live behavior is byte-for-byte unchanged. The legacy
// `co-view.state` shell-state path (state-handlers.ts) is untouched and remains
// the only live producer→viewer channel.
//
// SECURITY POSTURE (foundation-plan §5):
//  - HOST-ONLY. Only a session's host connection may emit a render-tree frame;
//    a non-host frame is dropped + warned (mirrors `handleState`).
//  - VALIDATE WHOLE, THEN PROJECT. A malformed canonical frame is rejected as a
//    whole (via the CV-FOUND-1 schema) and NOTHING is sent to any viewer — never
//    a partial projection.
//  - PER-VIEWER PROJECTION. Each viewer's frame is projected independently
//    through the injected resolver/registry, so structure is byte-identical
//    across viewers while protected values differ by entitlement. Projection
//    itself fails closed (resolver throw → withhold, secret → placeholder) and
//    never rejects a schema-valid frame.
//  - SINGLE VALUE SOURCE. The projector takes no host-provided value for a
//    protected slot — the injected resolver is the sole authority.
//
// NOT in scope (later PRs / explicitly out): producer wiring into live CoView,
// viewer renderer changes, cache/invalidation, website UI changes. This module
// only makes the runtime *capable* of carrying projected frames under test/flag.

import type { ViewerContext, WsCoViewRenderTreeFrame } from "@uncorded/protocol";

import type { CoViewContext } from "./handlers";
import {
  projectCanonicalRenderFrame,
  type CoViewProjectionResult,
} from "./render-tree-projection";
import type { CoViewMemberInternal } from "./types";

/**
 * Master switch for the render-tree transport path. `false` until the producer
 * + viewer renderer ship. While `false`, an incoming `co-view.render-tree.frame`
 * is dropped without affecting the legacy state path. A test may flip the
 * behavior per-handle via `CoViewDeps.renderTreeTransport.enabled` WITHOUT
 * changing this constant — the constant remains the production default and the
 * fail-safe when no override is supplied.
 */
export const CO_VIEW_RENDER_TREE_TRANSPORT_ENABLED = false;

function traceContext(msg: WsCoViewRenderTreeFrame): {
  plugin: "co-view";
  request_id?: string;
  correlationId?: string;
} {
  const raw = msg as unknown as Record<string, unknown>;
  const requestId = raw["request_id"];
  const correlationId = raw["correlationId"] ?? raw["correlation_id"];
  return {
    plugin: "co-view",
    ...(typeof requestId === "string" && requestId.length > 0
      ? { request_id: requestId }
      : {}),
    ...(typeof correlationId === "string" && correlationId.length > 0
      ? { correlationId }
      : {}),
  };
}

function projectionErrorResult(error: unknown): CoViewProjectionResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    reason: "invalid-frame",
    issues: [`projection threw: ${message}`],
  };
}

/**
 * Handle a host-emitted canonical render frame: validate, project per viewer,
 * and forward one projected frame to each viewer. Async because projection
 * awaits the injected value resolver.
 *
 * Drops (sends nothing) when:
 *  - the transport flag/wiring is disabled (default),
 *  - the session is unknown,
 *  - the emitter is not the session host,
 *  - the canonical frame is malformed (rejected whole).
 */
export async function handleRenderTreeFrame(
  ctx: CoViewContext,
  msg: WsCoViewRenderTreeFrame,
  connectionId: string,
): Promise<void> {
  const log = ctx.log.child(traceContext(msg));

  // --- Gate: disabled by default ---------------------------------------
  // Resolve the effective enabled state. Production supplies no transport
  // wiring, so `transport` is undefined and the path is off. A test injects
  // registry + resolver and may set `enabled: true`; absent an explicit
  // override the disabled constant governs, so wiring alone never turns the
  // path live.
  const transport = ctx.deps.renderTreeTransport;
  const enabled = transport?.enabled ?? CO_VIEW_RENDER_TREE_TRANSPORT_ENABLED;
  if (!transport || !enabled) {
    // Drop silently (debug-level) — this is the steady-state production path
    // and must not touch session state or the legacy `co-view.state` channel.
    log.debug("co-view: render-tree frame dropped — transport disabled", {
      sessionId: msg.session_id,
      connectionId,
    });
    return;
  }

  const session = ctx.registry.get(msg.session_id);
  if (!session) {
    // Frame for an unknown session — drop silently, exactly like `handleState`.
    return;
  }

  // --- Host-only: a non-host may not emit render-tree frames ------------
  if (session.hostSessionId !== connectionId) {
    log.warn("co-view: non-host emitted render-tree frame", {
      sessionId: session.id,
      connectionId,
      surfaceId: msg.frame?.surfaceId,
    });
    return;
  }

  // --- Project per viewer and forward ----------------------------------
  // Project independently for each viewer (host excluded — it rendered the
  // canonical frame itself). Structure is preserved identically across viewers;
  // only protected values differ. A malformed frame makes EVERY per-viewer
  // projection reject (`ok: false`) → nothing is sent to anyone, satisfying
  // "rejects whole and sends nothing". We still compute it per viewer so the
  // resolver/registry remain the single, per-viewer value authority.
  const projections = await Promise.all(
    Array.from(session.members.values())
      .filter((member) => member.role !== "host")
      .map(async (
        member,
      ): Promise<{ member: CoViewMemberInternal; result: CoViewProjectionResult }> => {
        const viewer: ViewerContext = {
          userId: member.userId,
          serverId: ctx.deps.serverId,
        };

        try {
          const result = await projectCanonicalRenderFrame(
            msg.frame,
            transport.registry,
            viewer,
            transport.resolver,
          );
          return { member, result };
        } catch (error) {
          return { member, result: projectionErrorResult(error) };
        }
      }),
  );

  for (const { member, result } of projections) {

    if (!result.ok) {
      // Malformed/unsafe canonical frame — fail closed: send this viewer
      // nothing. (Deterministic across viewers since the schema verdict does
      // not depend on viewer identity, so a malformed frame yields an empty
      // send to all.)
      log.warn("co-view: render-tree frame rejected — invalid canonical frame", {
        sessionId: session.id,
        surfaceId: msg.frame?.surfaceId,
        issues: result.issues,
      });
      continue;
    }

    ctx.deps.sendToConnection(member.sessionId, {
      type: "co-view.render-tree.projected",
      session_id: session.id,
      frame: result.frame,
    });
  }
}
