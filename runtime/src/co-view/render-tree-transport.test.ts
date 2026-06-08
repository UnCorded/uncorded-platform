// Runtime render-tree transport path — handler tests (CV-FOUND-4b).
//
// This exercises the LIVE dispatch path added by CV-FOUND-4b: a host emits a
// `co-view.render-tree.frame`, the runtime projects it per viewer through the
// injected value authority, and forwards one `co-view.render-tree.projected`
// frame to each viewer. It proves the transport *capability* under the flag —
// NOT any production wiring (the producer is never wired into a live session
// and the viewer renderer is untouched).
//
// The harness mirrors handlers.test.ts (real Database / EventBus / presence /
// roles double) and additionally injects `renderTreeTransport` so the gated
// path can be turned on for the test. The producer builder + registry and the
// resolver double are reused from the CV-FOUND-4a e2e contract so the host
// frame, surface registry, and per-viewer authority are the REAL ones.
//
// Coverage (foundation-plan §6, §7 CV-FOUND-4b row):
//  - disabled flag (and unwired production default) drops the frame; the legacy
//    co-view.state path keeps working byte-for-byte
//  - enabled path projects + sends a viewer-specific frame to each viewer
//  - authorized viewer gets real values; unauthorized viewer gets placeholders
//  - controls / labels / structure are byte-identical across viewers
//  - a malformed canonical frame is rejected whole — nothing is sent
//  - a non-host emitter is blocked
//  - a throwing resolver fails closed: structure preserved, no protected bytes

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rootLogger } from "@uncorded/shared";
import { EventBus } from "../events/bus";
import { RateLimiter } from "../http/rate-limiter";
import { ScopedPresenceModule } from "../presence";
import type { PluginTransportProvider } from "../events/types";
import type { IpcMessage } from "../ipc/transport";
import type { CoreModule } from "../core";
import type { RolesEngine } from "../roles/engine";
import type { AuthenticatedUser } from "../ws/types";
import type {
  CoViewCanonicalRenderFrame,
  CoViewProjectedNode,
  CoViewProjectedValue,
  JsonValue,
  ResolvedPluginResourceValue,
  ViewerContext,
  WsCoViewRenderTreeFrame,
  WsCoViewRenderTreeProjected,
  WsCoViewState,
  WsCoViewStartReq,
  WsCoViewJoinReq,
} from "@uncorded/protocol";

import {
  buildTextChannelPanelFrame,
  TEXT_CHANNEL_PANEL_REGISTRY,
  TEXT_CHANNEL_PANEL_SLOTS,
  type TextChannelPanelInput,
} from "../../../apps/website/src/co-view/render-tree-producer";
import { startCoView } from "./register";
import type { CoViewClientMessage, CoViewDeps, CoViewHandle } from "./types";
import {
  projectCanonicalRenderFrame,
  type CoViewGatedResolveRequest,
  type CoViewValueResolver,
} from "./render-tree-projection";

// ---------------------------------------------------------------------------
// Schema (mirrors handlers.test.ts — kept inline so the test is self-contained)
// ---------------------------------------------------------------------------

const SCHEMA_AUDIT = `
  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    actor_user_id TEXT    NOT NULL,
    actor_role    TEXT    NOT NULL,
    action        TEXT    NOT NULL,
    target_type   TEXT,
    target_id     TEXT,
    payload_json  TEXT    NOT NULL
  );
`;

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Sent {
  to: string;
  msg: { type: string } & Record<string, unknown>;
}

interface TransportOpts {
  resolver: CoViewValueResolver;
  enabled?: boolean | undefined;
}

interface Harness {
  handle: CoViewHandle;
  db: Database;
  sent: Sent[];
  setUser: (connId: string, user: AuthenticatedUser) => void;
  setSessionIdSequence: (ids: string[]) => void;
  dispose: () => void;
}

function makeUser(id: string, role = "member"): AuthenticatedUser {
  return { id, username: id, displayName: id, avatarUrl: "", role };
}

/**
 * Build a CoView handle with a virtual clock and (optionally) injected
 * render-tree transport wiring. When `transport` is omitted the path is fully
 * unwired — exactly the production default — so a render-tree frame is dropped.
 */
function makeHarness(transport?: TransportOpts): Harness {
  const db = new Database(":memory:");
  db.run(SCHEMA_AUDIT);

  const sent: Sent[] = [];
  const users = new Map<string, AuthenticatedUser>();
  const log = rootLogger.child({ test: "co-view-render-tree-transport" });

  let t = 1_000;
  const now = (): number => t;

  const sentByPlugin = new Map<string, IpcMessage[]>();
  const transportProvider: PluginTransportProvider = {
    getTransport(slug: string) {
      let arr = sentByPlugin.get(slug);
      if (!arr) {
        arr = [];
        sentByPlugin.set(slug, arr);
      }
      return {
        send(msg: IpcMessage) {
          arr!.push(msg);
        },
        onMessage() {},
        close() {},
      } as unknown as ReturnType<PluginTransportProvider["getTransport"]>;
    },
    isPluginAlive: () => true,
  };
  const eventBus = new EventBus(transportProvider);
  const rateLimiter = new RateLimiter(now);
  const presence = new ScopedPresenceModule(eventBus, rateLimiter, log, {
    installedSlugs: () => new Set<string>(),
    now,
  });

  const rolesEngine: RolesEngine = {
    check: (_userId: string, _key: string, caller: { isOwner: boolean }) => {
      if (caller.isOwner) return true;
      return true;
    },
    getRole: () => ({ name: "member", level: 0 }),
  } as unknown as RolesEngine;

  let sessionIdSeq: string[] = [];
  let sessionIdIdx = 0;

  const deps: CoViewDeps = {
    db,
    logger: log,
    eventBus,
    coreModule: {} as unknown as CoreModule,
    rolesEngine,
    presenceModule: presence,
    serverId: "srv-test",
    sendToConnection: (connectionId, msg) =>
      sent.push({ to: connectionId, msg: msg as Sent["msg"] }),
    getConnectedUser: (connectionId) => users.get(connectionId),
    now,
    generateSessionId: () => {
      if (sessionIdIdx < sessionIdSeq.length) {
        return sessionIdSeq[sessionIdIdx++]!;
      }
      return `sess-${String(sessionIdIdx++)}`;
    },
    ...(transport !== undefined
      ? {
          renderTreeTransport: {
            registry: TEXT_CHANNEL_PANEL_REGISTRY,
            resolver: transport.resolver,
            enabled: transport.enabled,
          },
        }
      : {}),
  };

  const handle = startCoView(deps);

  return {
    handle,
    db,
    sent,
    setUser: (connId, user) => {
      users.set(connId, user);
      presence.registerSession(connId);
    },
    setSessionIdSequence: (ids) => {
      sessionIdSeq = ids;
      sessionIdIdx = 0;
    },
    dispose: () => {
      handle.dispose();
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Frame builders
// ---------------------------------------------------------------------------

function startReq(visibility: "public" | "private" = "public"): WsCoViewStartReq {
  return {
    type: "co-view.start.req",
    visibility,
    whitelist: [],
    blacklist: [],
    render_mode: "as-host",
    redactions: { panel_ids: [], plugin_slugs: [], custom_selectors: [] },
  };
}

function joinReq(sessionId: string): WsCoViewJoinReq {
  return { type: "co-view.join.req", session_id: sessionId };
}

function renderTreeFrame(
  sessionId: string,
  frame: CoViewCanonicalRenderFrame,
): WsCoViewRenderTreeFrame {
  return { type: "co-view.render-tree.frame", session_id: sessionId, frame };
}

function stateFrame(sessionId: string, diff: Record<string, JsonValue>): WsCoViewState {
  return {
    type: "co-view.state",
    session_id: sessionId,
    seq: 0,
    diff,
    replay: "safe",
    ts: 0,
  };
}

async function dispatch(
  h: Harness,
  connectionId: string,
  msg: CoViewClientMessage,
): Promise<void> {
  await h.handle.dispatch(connectionId, msg);
}

// ---------------------------------------------------------------------------
// Realistic fixture + injected authority (reused from the CV-FOUND-4a contract)
// ---------------------------------------------------------------------------

const CHANNEL_ID = "c1";
const MESSAGE_ID = "m1";
const CHANNEL_NAME = "leadership";
const MSG_AUTHOR = "John Doe";
const MSG_TIMESTAMP = "10:42 AM";
const MSG_BODY = "We need to review pricing before launch.";

const PROTECTED_STRINGS = [CHANNEL_NAME, MSG_AUTHOR, MSG_TIMESTAMP, MSG_BODY, "pricing"];

const REAL_VALUE_BY_SLOT: Readonly<Record<string, string>> = {
  [TEXT_CHANNEL_PANEL_SLOTS.channelName]: CHANNEL_NAME,
  [TEXT_CHANNEL_PANEL_SLOTS.messageAuthor]: MSG_AUTHOR,
  [TEXT_CHANNEL_PANEL_SLOTS.messageTimestamp]: MSG_TIMESTAMP,
  [TEXT_CHANNEL_PANEL_SLOTS.messageBody]: MSG_BODY,
};

const CONTROL_LABELS: Readonly<Record<string, string>> = {
  "btn-delete-label": "Delete channel",
  "btn-copy-label": "Copy link",
  "act-reply-label": "Reply",
  "act-react-label": "React",
};

const PROTECTED_NODE_IDS = [
  TEXT_CHANNEL_PANEL_SLOTS.channelName,
  TEXT_CHANNEL_PANEL_SLOTS.messageAuthor,
  TEXT_CHANNEL_PANEL_SLOTS.messageTimestamp,
  TEXT_CHANNEL_PANEL_SLOTS.messageBody,
];

function fixtureInput(): TextChannelPanelInput {
  return {
    channelId: CHANNEL_ID,
    channelName: CHANNEL_NAME,
    channelIconGlyph: "#",
    message: {
      messageId: MESSAGE_ID,
      author: MSG_AUTHOR,
      timestamp: MSG_TIMESTAMP,
      body: MSG_BODY,
      hovered: true,
      boxes: {
        row: { x: 0, y: 40, width: 320, height: 24 },
        author: { x: 8, y: 40, width: 64, height: 16 },
        timestamp: { x: 76, y: 40, width: 48, height: 16 },
        body: { x: 8, y: 58, width: 300, height: 18 },
      },
    },
    rowActions: [
      { id: "act-react", controlKind: "button", classTokens: ["action"], label: "React" },
      { id: "act-reply", controlKind: "button", classTokens: ["action"], label: "Reply" },
    ],
    contextMenuOpen: true,
    contextMenuItems: [
      { id: "btn-copy", controlKind: "menuitem", classTokens: ["item"], label: "Copy link" },
      {
        id: "btn-delete",
        controlKind: "menuitem",
        classTokens: ["item", "danger"],
        label: "Delete channel",
        state: { hovered: true },
      },
    ],
  };
}

function buildFixtureFrame(): CoViewCanonicalRenderFrame {
  return buildTextChannelPanelFrame(fixtureInput());
}

const VERSIONS = { resourceAclVersion: 1, resourcePermissionVersion: 1 } as const;
const AUTHORIZED = "billy";
const UNAUTHORIZED = "sarah";

function makeResolver(
  behavior: (viewer: ViewerContext, req: CoViewGatedResolveRequest) => ResolvedPluginResourceValue,
): CoViewValueResolver {
  return {
    resolveGatedValue(v, req) {
      return behavior(v, req);
    },
  };
}

/** Authorizes only `billy`; everyone else is withheld with a synthetic skeleton. */
function viewerAwareResolver(): CoViewValueResolver {
  return makeResolver((v, req) => {
    if (v.userId !== AUTHORIZED) {
      return { state: "withheld", placeholderShape: { mode: "synthetic" }, versions: VERSIONS };
    }
    const value = REAL_VALUE_BY_SLOT[req.slotId];
    if (value === undefined) {
      return { state: "unsupported", reason: `unexpected-slot:${req.slotId}` };
    }
    return { state: "visible", value, versions: VERSIONS };
  });
}

/** A resolver that always throws — projection must fail closed (withhold). */
function throwingResolver(): CoViewValueResolver {
  return makeResolver(() => {
    throw new Error("authority unavailable");
  });
}

// ---------------------------------------------------------------------------
// Tree / assertion helpers
// ---------------------------------------------------------------------------

function findNode(node: CoViewProjectedNode, id: string): CoViewProjectedNode | null {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

function stripValues(node: CoViewProjectedNode): unknown {
  const { value: _value, children, ...rest } = node;
  return {
    ...rest,
    ...(children !== undefined ? { children: children.map(stripValues) } : {}),
  };
}

function visible(value: JsonValue): CoViewProjectedValue {
  return { state: "visible", value };
}

const WITHHELD: CoViewProjectedValue = {
  state: "withheld",
  placeholderShape: { mode: "synthetic" },
};

function projectedFrames(h: Harness, to?: string): WsCoViewRenderTreeProjected[] {
  const out: WsCoViewRenderTreeProjected[] = [];
  for (const s of h.sent) {
    if (s.msg.type === "co-view.render-tree.projected" && (to === undefined || s.to === to)) {
      out.push(s.msg as unknown as WsCoViewRenderTreeProjected);
    }
  }
  return out;
}

function projectedRoot(h: Harness, to: string): CoViewProjectedNode {
  const frames = projectedFrames(h, to);
  if (frames.length !== 1) {
    throw new Error(`expected exactly one projected frame for ${to}, got ${String(frames.length)}`);
  }
  return frames[0]!.frame.root;
}

/**
 * Boot a session: one host (`c-host`/`u-host`), one authorized viewer
 * (`c-billy`/`billy`), one unauthorized viewer (`c-sarah`/`sarah`). Public
 * visibility so both viewers can join. Clears `sent` before returning.
 */
async function bootHostAndViewers(h: Harness): Promise<string> {
  h.setUser("c-host", makeUser("u-host"));
  h.setUser("c-billy", makeUser(AUTHORIZED));
  h.setUser("c-sarah", makeUser(UNAUTHORIZED));
  h.setSessionIdSequence(["sess-RT"]);
  await dispatch(h, "c-host", startReq("public"));
  await dispatch(h, "c-billy", joinReq("sess-RT"));
  await dispatch(h, "c-sarah", joinReq("sess-RT"));
  h.sent.length = 0;
  return "sess-RT";
}

// ---------------------------------------------------------------------------
// Disabled by default
// ---------------------------------------------------------------------------

describe("render-tree transport — disabled", () => {
  let h: Harness;
  afterEach(() => h.dispose());

  test("flag disabled: render-tree frame is dropped and the legacy state path is untouched", async () => {
    // Transport is wired (registry + resolver present) but explicitly disabled.
    h = makeHarness({ resolver: viewerAwareResolver(), enabled: false });
    const sid = await bootHostAndViewers(h);

    await dispatch(h, "c-host", renderTreeFrame(sid, buildFixtureFrame()));

    // Nothing projected to anyone — the path is off.
    expect(projectedFrames(h)).toHaveLength(0);

    // The legacy co-view.state path still forwards to viewers exactly as before.
    await dispatch(h, "c-host", stateFrame(sid, { route: "/server/foo" }));
    const billyState = h.sent.filter(
      (s) => s.msg.type === "co-view.state" && s.to === "c-billy",
    );
    const sarahState = h.sent.filter(
      (s) => s.msg.type === "co-view.state" && s.to === "c-sarah",
    );
    expect(billyState).toHaveLength(1);
    expect(sarahState).toHaveLength(1);
    // Host snapshot updated by the legacy path — render-tree frame never touched it.
    const sess = h.handle._internals().sessions.get(sid)!;
    expect(sess.safeStateSnapshot).toEqual({ route: "/server/foo" });
  });

  test("unwired production default: render-tree frame is dropped without any transport deps", async () => {
    // No transport injected at all — the steady-state production configuration.
    h = makeHarness();
    const sid = await bootHostAndViewers(h);

    await dispatch(h, "c-host", renderTreeFrame(sid, buildFixtureFrame()));

    expect(projectedFrames(h)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Enabled test-only path
// ---------------------------------------------------------------------------

describe("render-tree transport — enabled", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness({ resolver: viewerAwareResolver(), enabled: true });
  });
  afterEach(() => h.dispose());

  test("host frame projects and sends one viewer-specific projected frame per viewer (not the host)", async () => {
    const sid = await bootHostAndViewers(h);

    await dispatch(h, "c-host", renderTreeFrame(sid, buildFixtureFrame()));

    expect(projectedFrames(h, "c-billy")).toHaveLength(1);
    expect(projectedFrames(h, "c-sarah")).toHaveLength(1);
    // The host rendered the canonical frame itself — it is never sent a projection.
    expect(projectedFrames(h, "c-host")).toHaveLength(0);
    // Every projected frame is stamped with the right session.
    for (const f of projectedFrames(h)) {
      expect(f.session_id).toBe(sid);
    }
  });

  test("authorized viewer receives the real values from the injected resolver", async () => {
    const sid = await bootHostAndViewers(h);
    await dispatch(h, "c-host", renderTreeFrame(sid, buildFixtureFrame()));

    const billy = projectedRoot(h, "c-billy");
    for (const id of PROTECTED_NODE_IDS) {
      expect(findNode(billy, id)?.value).toEqual(visible(REAL_VALUE_BY_SLOT[id]!));
    }
    // The protected bytes genuinely cross the authorized wire.
    const serialized = JSON.stringify(billy);
    for (const secret of PROTECTED_STRINGS) {
      expect(serialized).toContain(secret);
    }
  });

  test("unauthorized viewer receives placeholders and never a protected byte", async () => {
    const sid = await bootHostAndViewers(h);
    await dispatch(h, "c-host", renderTreeFrame(sid, buildFixtureFrame()));

    const sarah = projectedRoot(h, "c-sarah");
    for (const id of PROTECTED_NODE_IDS) {
      expect(findNode(sarah, id)?.value).toEqual(WITHHELD);
    }
    const serialized = JSON.stringify(sarah);
    for (const secret of PROTECTED_STRINGS) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("controls, labels, and structure are byte-identical across the two projected frames", async () => {
    const sid = await bootHostAndViewers(h);
    await dispatch(h, "c-host", renderTreeFrame(sid, buildFixtureFrame()));

    const billy = projectedRoot(h, "c-billy");
    const sarah = projectedRoot(h, "c-sarah");

    // ids / kinds / boxes / state / attrs / children order — identical.
    expect(stripValues(sarah)).toEqual(stripValues(billy));
    // Control affordance labels are public chrome and identical for both viewers.
    for (const [labelId, text] of Object.entries(CONTROL_LABELS)) {
      expect(findNode(billy, labelId)?.value).toEqual(visible(text));
      expect(findNode(sarah, labelId)?.value).toEqual(visible(text));
    }
    // Host interaction state mirrors to the unauthorized viewer too.
    expect(findNode(sarah, "context-menu")?.state).toEqual({ open: true });
    expect(findNode(sarah, "btn-delete")?.state).toEqual({ hovered: true });
  });

  test("a malformed canonical frame is rejected whole — nothing is sent to any viewer", async () => {
    const sid = await bootHostAndViewers(h);
    const frame = buildFixtureFrame();
    // Corrupt the root node kind — the canonical schema must reject the frame.
    (frame.root as { kind: string }).kind = "not-a-real-kind";

    await dispatch(h, "c-host", renderTreeFrame(sid, frame));

    // The schema verdict is viewer-independent, so a malformed frame yields an
    // empty send to everyone — never a partial projection.
    expect(projectedFrames(h)).toHaveLength(0);
  });

  test("a non-host emitter cannot push render-tree frames", async () => {
    const sid = await bootHostAndViewers(h);

    // c-billy is a viewer, not the host.
    await dispatch(h, "c-billy", renderTreeFrame(sid, buildFixtureFrame()));

    expect(projectedFrames(h)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fail closed — throwing resolver
// ---------------------------------------------------------------------------

describe("render-tree transport — fail closed", () => {
  let h: Harness;
  afterEach(() => h.dispose());

  test("a throwing resolver withholds every protected value while preserving structure and leaking nothing", async () => {
    h = makeHarness({ resolver: throwingResolver(), enabled: true });
    const sid = await bootHostAndViewers(h);

    await dispatch(h, "c-host", renderTreeFrame(sid, buildFixtureFrame()));

    // Projection does not reject a schema-valid frame — it still sends to viewers.
    const billy = projectedRoot(h, "c-billy");
    const sarah = projectedRoot(h, "c-sarah");

    // Every protected value is withheld with a same-intent synthetic placeholder.
    for (const root of [billy, sarah]) {
      for (const id of PROTECTED_NODE_IDS) {
        expect(findNode(root, id)?.value).toEqual(WITHHELD);
      }
    }

    // Structure matches a clean authorized projection — only values changed.
    const cleanRef = await projectCanonicalRenderFrame(
      buildFixtureFrame(),
      TEXT_CHANNEL_PANEL_REGISTRY,
      { userId: AUTHORIZED, serverId: "srv-test" },
      viewerAwareResolver(),
    );
    expect(cleanRef.ok).toBe(true);
    if (cleanRef.ok) {
      expect(stripValues(billy)).toEqual(stripValues(cleanRef.frame.root));
    }

    // No protected byte exists on the wire, and the controls/labels still mirror.
    for (const root of [billy, sarah]) {
      const serialized = JSON.stringify(root);
      for (const secret of PROTECTED_STRINGS) {
        expect(serialized).not.toContain(secret);
      }
      expect(findNode(root, "btn-delete-label")?.value).toEqual(visible("Delete channel"));
    }
  });
});
