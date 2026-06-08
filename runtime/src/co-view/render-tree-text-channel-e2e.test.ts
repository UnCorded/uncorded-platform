// CoView text-channel render-tree END-TO-END CONTRACT (CV-FOUND-4a).
//
// This is a TEST-ONLY contract that wires the three foundation pieces together
// and proves they behave as ONE pipeline (foundation-plan §6, §7 CV-FOUND-4 row):
//
//   website producer (CV-FOUND-3)  ->  schema + surface registry (CV-FOUND-1)
//                                  ->  runtime projection core (CV-FOUND-2)
//
// It does NOT wire any live CoView broadcast, viewer renderer, router, or cache —
// CV-FOUND-4 proper owns that. Here we take the REAL website builder
// (`buildTextChannelPanelFrame`) and the REAL producer registry
// (`TEXT_CHANNEL_PANEL_REGISTRY`), feed them through the REAL runtime projector
// (`projectCanonicalRenderFrame`) with an injected value authority, and assert the
// production boundary holds for two different viewers of the SAME host frame:
//
//   control visibility = host permissions   (controls/buttons/menus mirror as-is)
//   data visibility     = viewer permissions (data-bearing values project per viewer)
//
// The producer holds the real channel/message strings but is structurally
// incapable of being the privacy authority for them (the gated slots are
// runtime-resolved). The ONLY source of real bytes here is the injected resolver,
// and only after it authorizes the viewer — so an unauthorized viewer's wire never
// carries a protected byte even though the host frame is byte-identical.
//
// Import note: the producer is a pure module whose only `@uncorded/protocol`
// imports are types (erased at runtime), so a runtime-side test can consume it
// directly — exactly the "forward-compatible with the runtime projector without a
// translation layer" property CV-FOUND-3 designed for.

import { describe, expect, test } from "bun:test";
import type {
  CoViewCanonicalRenderFrame,
  CoViewCanonicalValueRef,
  CoViewProjectedNode,
  CoViewProjectedValue,
  CoViewRenderNode,
  JsonValue,
  ResolvedPluginResourceValue,
  ViewerContext,
} from "@uncorded/protocol";
import {
  CoViewCanonicalRenderFrameSchema,
  validateCanonicalSlotValue,
} from "@uncorded/protocol-schemas";

import {
  buildTextChannelPanelFrame,
  TEXT_CHANNEL_PANEL_REGISTRY,
  TEXT_CHANNEL_PANEL_SLOTS,
  TEXT_CHANNEL_PANEL_SURFACE_ID,
  type TextChannelPanelInput,
} from "../../../apps/website/src/co-view/render-tree-producer";
import {
  projectCanonicalRenderFrame,
  type CoViewGatedResolveRequest,
  type CoViewValueResolver,
} from "./render-tree-projection";

// ---------------------------------------------------------------------------
// Realistic fixture (foundation-plan §3.1) — the protected strings here live
// ONLY in the resolver. They must reach an authorized viewer and never an
// unauthorized one, and must never appear in the host frame the producer emits.
// ---------------------------------------------------------------------------

const CHANNEL_ID = "c1";
const MESSAGE_ID = "m1";
const CHANNEL_NAME = "leadership";
const MSG_AUTHOR = "John Doe";
const MSG_TIMESTAMP = "10:42 AM";
const MSG_BODY = "We need to review pricing before launch.";

/** Every protected byte the resolver can surface — asserted present on the
 *  authorized wire and absent from the unauthorized wire. */
const PROTECTED_STRINGS = [CHANNEL_NAME, MSG_AUTHOR, MSG_TIMESTAMP, MSG_BODY, "pricing"];

/** The real value the injected authority returns per protected slot. Keyed by
 *  slot id, which (by the producer convention) equals the protected node id. */
const REAL_VALUE_BY_SLOT: Readonly<Record<string, string>> = {
  [TEXT_CHANNEL_PANEL_SLOTS.channelName]: CHANNEL_NAME,
  [TEXT_CHANNEL_PANEL_SLOTS.messageAuthor]: MSG_AUTHOR,
  [TEXT_CHANNEL_PANEL_SLOTS.messageTimestamp]: MSG_TIMESTAMP,
  [TEXT_CHANNEL_PANEL_SLOTS.messageBody]: MSG_BODY,
};

/** The four host-rendered controls the slice must mirror to every viewer:
 *  delete + copy in the context menu, reply + react as row actions. The
 *  `label` is generic affordance chrome (mirrors public), never protected data. */
const CONTROL_LABELS: Readonly<Record<string, string>> = {
  "btn-delete-label": "Delete channel",
  "btn-copy-label": "Copy link",
  "act-reply-label": "Reply",
  "act-react-label": "React",
};

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

/** A realistic text-channel canonical frame built by the REAL producer. Fresh
 *  per call so a tampering test never mutates another test's fixture. */
function buildFixtureFrame(): CoViewCanonicalRenderFrame {
  return buildTextChannelPanelFrame(fixtureInput());
}

// ---------------------------------------------------------------------------
// Injected value authority (the only source of real protected bytes)
// ---------------------------------------------------------------------------

const VERSIONS = { resourceAclVersion: 1, resourcePermissionVersion: 1 } as const;

/** Viewer who can read the channel — the resolver authorizes them. */
const AUTHORIZED = "billy";
/** Viewer who cannot — the resolver withholds. */
const UNAUTHORIZED = "sarah";

function viewer(userId: string): ViewerContext {
  return { userId, serverId: "srv-1" };
}

interface CapturingResolver {
  resolver: CoViewValueResolver;
  calls: Array<{ userId: string; request: CoViewGatedResolveRequest }>;
}

function makeResolver(
  behavior: (viewer: ViewerContext, req: CoViewGatedResolveRequest) => ResolvedPluginResourceValue,
): CapturingResolver {
  const calls: Array<{ userId: string; request: CoViewGatedResolveRequest }> = [];
  return {
    calls,
    resolver: {
      resolveGatedValue(v, req) {
        calls.push({ userId: v.userId, request: req });
        return behavior(v, req);
      },
    },
  };
}

/**
 * The production-shaped authority: it authorizes only `AUTHORIZED`, and only then
 * materializes the real bytes for the requested slot. Everyone else is withheld
 * with a same-intent synthetic placeholder. The per-viewer difference comes from
 * viewer identity alone — the host frame handed to projection is identical.
 */
function viewerAwareResolver(): CapturingResolver {
  return makeResolver((v, req) => {
    if (v.userId !== AUTHORIZED) {
      return { state: "withheld", placeholderShape: { mode: "synthetic" }, versions: VERSIONS };
    }
    const value = REAL_VALUE_BY_SLOT[req.slotId];
    if (value === undefined) {
      // The producer should only ever ask for the four registered slots.
      return { state: "unsupported", reason: `unexpected-slot:${req.slotId}` };
    }
    return { state: "visible", value, versions: VERSIONS };
  });
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function walkCanonical(node: CoViewRenderNode, visit: (n: CoViewRenderNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walkCanonical(child, visit);
}

function findNode(node: CoViewProjectedNode, id: string): CoViewProjectedNode | null {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

/** Structure with all `value` payloads stripped, to compare shape across viewers. */
function stripValues(node: CoViewProjectedNode): unknown {
  const { value: _value, children, ...rest } = node;
  return {
    ...rest,
    ...(children !== undefined ? { children: children.map(stripValues) } : {}),
  };
}

/** Expected projected value for an authorized (visible) data slot. */
function visible(value: JsonValue): CoViewProjectedValue {
  return { state: "visible", value };
}

/** Expected projected value for a withheld data slot (synthetic skeleton). */
const WITHHELD: CoViewProjectedValue = {
  state: "withheld",
  placeholderShape: { mode: "synthetic" },
};

function unwrap(
  result: Awaited<ReturnType<typeof projectCanonicalRenderFrame>>,
): CoViewProjectedNode {
  if (!result.ok) {
    throw new Error(`expected ok projection, got ${result.reason}: ${result.issues.join(", ")}`);
  }
  return result.frame.root;
}

/** The four protected node ids (== slot ids) the slice gates. */
const PROTECTED_NODE_IDS = [
  TEXT_CHANNEL_PANEL_SLOTS.channelName,
  TEXT_CHANNEL_PANEL_SLOTS.messageAuthor,
  TEXT_CHANNEL_PANEL_SLOTS.messageTimestamp,
  TEXT_CHANNEL_PANEL_SLOTS.messageBody,
];

/** The four control nodes that must mirror to every viewer. */
const CONTROL_NODE_IDS = ["btn-delete", "btn-copy", "act-reply", "act-react"];

async function project(
  frame: CoViewCanonicalRenderFrame,
  userId: string,
  resolver: CoViewValueResolver,
): Promise<CoViewProjectedNode> {
  return unwrap(
    await projectCanonicalRenderFrame(frame, TEXT_CHANNEL_PANEL_REGISTRY, viewer(userId), resolver),
  );
}

// ---------------------------------------------------------------------------
// Registry / schema integration — the producer frame is contract-valid and the
// runtime projector consumes the producer registry end to end.
// ---------------------------------------------------------------------------

describe("text-channel e2e — producer frame integrates with schema + registry", () => {
  test("the producer frame passes CoViewCanonicalRenderFrameSchema", () => {
    const parsed = CoViewCanonicalRenderFrameSchema.safeParse(buildFixtureFrame());
    expect(parsed.success).toBe(true);
  });

  test("every gated producer value passes validateCanonicalSlotValue against the producer registry", () => {
    const frame = buildFixtureFrame();
    const gated: Array<{ id: string; value: CoViewCanonicalValueRef }> = [];
    walkCanonical(frame.root, (n) => {
      if (n.value?.origin === "gated") gated.push({ id: n.id, value: n.value });
    });

    // The slice gates exactly the four protected values (channel name + the three
    // message fields) — nothing more, nothing fewer.
    expect(gated.map((g) => g.id).sort()).toEqual([...PROTECTED_NODE_IDS].sort());

    for (const { id, value } of gated) {
      const result = validateCanonicalSlotValue(
        TEXT_CHANNEL_PANEL_REGISTRY,
        TEXT_CHANNEL_PANEL_SURFACE_ID,
        id,
        value,
      );
      expect(result).toEqual({ ok: true });
    }
  });

  test("projectCanonicalRenderFrame consumes the producer registry and resolves every gated slot", async () => {
    const frame = buildFixtureFrame();
    const r = viewerAwareResolver();
    const result = await projectCanonicalRenderFrame(
      frame,
      TEXT_CHANNEL_PANEL_REGISTRY,
      viewer(AUTHORIZED),
      r.resolver,
    );

    expect(result.ok).toBe(true);
    // The producer registry validated each protected slot, so each reached the
    // injected authority exactly once — proving the registry is the live gate.
    expect(r.calls.map((c) => c.request.slotId).sort()).toEqual([...PROTECTED_NODE_IDS].sort());
    // The authority received the producer's registered policy/resource claim, never
    // a host-provided value.
    const channelCall = r.calls.find((c) => c.request.slotId === TEXT_CHANNEL_PANEL_SLOTS.channelName);
    expect(channelCall?.request.policyRef).toBe("channel.read");
    expect(channelCall?.request.resourceRef).toEqual({ kind: "channel", channelId: CHANNEL_ID });
    const bodyCall = r.calls.find((c) => c.request.slotId === TEXT_CHANNEL_PANEL_SLOTS.messageBody);
    expect(bodyCall?.request.policyRef).toBe("channel.message.read");
    expect(bodyCall?.request.resourceRef).toEqual({
      kind: "message",
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
    });
  });
});

// ---------------------------------------------------------------------------
// Structure parity — same frame, two viewers, only protected values differ.
// ---------------------------------------------------------------------------

describe("text-channel e2e — structure parity across two viewers", () => {
  test("authorized and unauthorized viewers receive byte-identical structure", async () => {
    const frame = buildFixtureFrame();
    const r = viewerAwareResolver();
    const billy = await project(frame, AUTHORIZED, r.resolver);
    const sarah = await project(frame, UNAUTHORIZED, r.resolver);

    // ids / kinds / boxes / state / attrs / children order — all identical.
    expect(stripValues(sarah)).toEqual(stripValues(billy));
  });

  test("only the protected value payloads differ; all public chrome is identical", async () => {
    const frame = buildFixtureFrame();
    const r = viewerAwareResolver();
    const billy = await project(frame, AUTHORIZED, r.resolver);
    const sarah = await project(frame, UNAUTHORIZED, r.resolver);

    // Protected values differ: real for Billy, withheld for Sarah.
    for (const id of PROTECTED_NODE_IDS) {
      const real = REAL_VALUE_BY_SLOT[id]!;
      expect(findNode(billy, id)?.value).toEqual(visible(real));
      expect(findNode(sarah, id)?.value).toEqual(WITHHELD);
    }

    // Public chrome (the channel-type glyph + every control label) is byte-identical.
    expect(findNode(billy, "channel-icon")?.value).toEqual(visible("#"));
    expect(findNode(sarah, "channel-icon")?.value).toEqual(visible("#"));
    for (const [labelId, text] of Object.entries(CONTROL_LABELS)) {
      expect(findNode(billy, labelId)?.value).toEqual(visible(text));
      expect(findNode(sarah, labelId)?.value).toEqual(visible(text));
    }
  });
});

// ---------------------------------------------------------------------------
// Controls mirror — host UI, not viewer permissions.
// ---------------------------------------------------------------------------

describe("text-channel e2e — controls mirror to both viewers", () => {
  test("delete / copy / reply / react controls exist for BOTH viewers and are never gated away", async () => {
    const frame = buildFixtureFrame();
    const r = viewerAwareResolver();
    const billy = await project(frame, AUTHORIZED, r.resolver);
    const sarah = await project(frame, UNAUTHORIZED, r.resolver);

    for (const root of [billy, sarah]) {
      for (const id of CONTROL_NODE_IDS) {
        const node = findNode(root, id);
        expect(node).not.toBeNull();
        expect(node?.kind).toBe("control");
        expect(node?.attrs?.controlKind).toBeDefined();
        // A control carries no data value — present and unchanged, never projected away.
        expect(node !== null && "value" in node).toBe(false);
      }
    }
  });

  test("control labels are PUBLIC and identical for both viewers (video-like explanation)", async () => {
    const frame = buildFixtureFrame();
    const r = viewerAwareResolver();
    const billy = await project(frame, AUTHORIZED, r.resolver);
    const sarah = await project(frame, UNAUTHORIZED, r.resolver);

    for (const [labelId, text] of Object.entries(CONTROL_LABELS)) {
      const b = findNode(billy, labelId);
      const s = findNode(sarah, labelId);
      expect(b?.kind).toBe("text");
      // Same generic affordance text reaches both viewers.
      expect(b?.value).toEqual(visible(text));
      expect(s?.value).toEqual(b?.value);
    }
  });

  test("host interaction state (open menu, hovered delete/row) mirrors to the UNAUTHORIZED viewer too", async () => {
    const frame = buildFixtureFrame();
    const sarah = await project(frame, UNAUTHORIZED, viewerAwareResolver().resolver);

    expect(findNode(sarah, "context-menu")?.state).toEqual({ open: true });
    expect(findNode(sarah, "btn-delete")?.state).toEqual({ hovered: true });
    expect(findNode(sarah, "message-row")?.state).toEqual({ hovered: true });
  });
});

// ---------------------------------------------------------------------------
// Protected bytes — present where authorized, absent everywhere unauthorized.
// ---------------------------------------------------------------------------

describe("text-channel e2e — protected bytes cross only the authorized wire", () => {
  test("the authorized projected frame carries the real channel/message bytes where expected", async () => {
    const frame = buildFixtureFrame();
    const billy = await project(frame, AUTHORIZED, viewerAwareResolver().resolver);

    expect(findNode(billy, TEXT_CHANNEL_PANEL_SLOTS.channelName)?.value).toEqual(visible(CHANNEL_NAME));
    expect(findNode(billy, TEXT_CHANNEL_PANEL_SLOTS.messageAuthor)?.value).toEqual(visible(MSG_AUTHOR));
    expect(findNode(billy, TEXT_CHANNEL_PANEL_SLOTS.messageTimestamp)?.value).toEqual(
      visible(MSG_TIMESTAMP),
    );
    expect(findNode(billy, TEXT_CHANNEL_PANEL_SLOTS.messageBody)?.value).toEqual(visible(MSG_BODY));

    // Every protected byte is genuinely present on the authorized wire.
    const serialized = JSON.stringify(billy);
    for (const secret of PROTECTED_STRINGS) {
      expect(serialized).toContain(secret);
    }
  });

  test("no protected byte appears ANYWHERE in the unauthorized projected frame (foundation-plan §5.4)", async () => {
    const frame = buildFixtureFrame();
    const sarah = await project(frame, UNAUTHORIZED, viewerAwareResolver().resolver);

    const serialized = JSON.stringify(sarah);
    for (const secret of PROTECTED_STRINGS) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("the host frame itself never carried the protected bytes (producer is not the privacy authority)", () => {
    // The producer holds the real strings yet drops them: the gated slots are
    // runtime-resolved, so the host frame the runtime receives is already clean.
    const serialized = JSON.stringify(buildFixtureFrame());
    for (const secret of PROTECTED_STRINGS) {
      expect(serialized).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------
// Failure paths — projection fails closed without breaking structure.
// ---------------------------------------------------------------------------

describe("text-channel e2e — fail closed", () => {
  test("a tampered frame that widens a protected slot to public withholds and leaks nothing", async () => {
    const frame = buildFixtureFrame();
    // Simulate a compromised/buggy producer shipping the real channel name as a
    // PUBLIC value on the gated channel-name slot — a widening attempt.
    const channelNameNode = findCanonical(frame.root, TEXT_CHANNEL_PANEL_SLOTS.channelName);
    expect(channelNameNode).not.toBeNull();
    (channelNameNode as { value: CoViewCanonicalValueRef }).value = {
      origin: "public",
      value: CHANNEL_NAME,
    };

    // Even for the AUTHORIZED viewer, the registry gate refuses to widen the slot:
    // the value is withheld and the real byte never reaches the wire.
    const r = viewerAwareResolver();
    const billy = await project(frame, AUTHORIZED, r.resolver);

    expect(findNode(billy, TEXT_CHANNEL_PANEL_SLOTS.channelName)?.value).toEqual(WITHHELD);
    expect(JSON.stringify(billy)).not.toContain(CHANNEL_NAME);
    // A widened public value never reaches the gate/resolver for that slot.
    expect(r.calls.some((c) => c.request.slotId === TEXT_CHANNEL_PANEL_SLOTS.channelName)).toBe(false);
    // The rest of the structure still projects normally (the other gated slots
    // resolved for this authorized viewer).
    expect(findNode(billy, TEXT_CHANNEL_PANEL_SLOTS.messageBody)?.value).toEqual(visible(MSG_BODY));
  });

  test("a throwing resolver withholds every gated value, preserves structure, and leaks nothing", async () => {
    const frame = buildFixtureFrame();
    const r = makeResolver(() => {
      throw new Error("authority unavailable");
    });

    const result = await projectCanonicalRenderFrame(
      frame,
      TEXT_CHANNEL_PANEL_REGISTRY,
      viewer(AUTHORIZED),
      r.resolver,
    );
    // Projection does not reject — it withholds and keeps the frame intact.
    expect(result.ok).toBe(true);
    const billy = unwrap(result);

    // Every protected value is withheld with a same-intent synthetic placeholder.
    for (const id of PROTECTED_NODE_IDS) {
      expect(findNode(billy, id)?.value).toEqual(WITHHELD);
    }

    // Structure is identical to a normal authorized projection — only values changed.
    const ok = await project(buildFixtureFrame(), AUTHORIZED, viewerAwareResolver().resolver);
    expect(stripValues(billy)).toEqual(stripValues(ok));

    // The resolver threw before returning anything, so no protected byte exists on
    // the wire — and the controls/labels still mirror.
    const serialized = JSON.stringify(billy);
    for (const secret of PROTECTED_STRINGS) {
      expect(serialized).not.toContain(secret);
    }
    expect(findNode(billy, "btn-delete-label")?.value).toEqual(visible("Delete channel"));
  });
});

// ---------------------------------------------------------------------------
// Local canonical-tree finder (the tamper test needs to mutate the host frame
// before projection; the projected-tree `findNode` works on a different shape).
// ---------------------------------------------------------------------------

function findCanonical(node: CoViewRenderNode, id: string): CoViewRenderNode | null {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = findCanonical(child, id);
    if (hit) return hit;
  }
  return null;
}
