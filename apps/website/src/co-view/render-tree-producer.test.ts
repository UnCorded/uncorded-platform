// CoView render-tree producer — text-channel panel slice (CV-FOUND-3) tests.
//
// These prove the producer-side contract for the first vertical slice:
//   - the emitted frame is schema-valid (`CoViewCanonicalRenderFrameSchema`);
//   - controls/menu/button nodes exist independent of any viewer permission
//     (the builder has no viewer parameter — control existence is host-only);
//   - channel/message protected values are `gated` with the correct
//     policyRef/resourceRef and every registered protected slot passes
//     `validateCanonicalSlotValue`;
//   - ordinary public chrome (the channel-type glyph) mirrors as `public`;
//   - no `origin: "local"` ever appears, and the real protected strings never
//     cross into the frame (the producer is not the privacy authority);
//   - widening a registered protected slot to `public` is rejected, proving the
//     fail-closed registry gate still blocks it.

import { describe, expect, test } from "bun:test";
import type {
  CoViewCanonicalValueRef,
  CoViewRenderNode,
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
} from "./render-tree-producer";

// ---------------------------------------------------------------------------
// Realistic fixture — the protected strings here must NEVER reach the frame.
// ---------------------------------------------------------------------------

const CHANNEL_ID = "c1";
const MESSAGE_ID = "m1";
const CHANNEL_NAME = "leadership";
const MSG_AUTHOR = "John Doe";
const MSG_TIMESTAMP = "10:42 AM";
const MSG_BODY = "We need to review pricing before launch.";

/** The protected fixture strings, asserted absent from non-gated/public chrome. */
const PROTECTED_STRINGS = [CHANNEL_NAME, MSG_AUTHOR, MSG_TIMESTAMP, MSG_BODY, "pricing"];

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
    },
    rowActions: [
      { id: "act-react", controlKind: "button", classTokens: ["action"], label: "React" },
      { id: "act-reply", controlKind: "button", classTokens: ["action"], label: "Reply" },
    ],
    contextMenuOpen: true,
    contextMenuItems: [
      { id: "btn-markread", controlKind: "menuitem", classTokens: ["item"], label: "Mark as read" },
      { id: "btn-copylink", controlKind: "menuitem", classTokens: ["item"], label: "Copy link" },
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

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function walk(node: CoViewRenderNode, visit: (n: CoViewRenderNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function findNode(root: CoViewRenderNode, id: string): CoViewRenderNode | null {
  let hit: CoViewRenderNode | null = null;
  walk(root, (n) => {
    if (hit === null && n.id === id) hit = n;
  });
  return hit;
}

function allNodes(root: CoViewRenderNode): CoViewRenderNode[] {
  const out: CoViewRenderNode[] = [];
  walk(root, (n) => out.push(n));
  return out;
}

// ---------------------------------------------------------------------------
// Schema validity
// ---------------------------------------------------------------------------

describe("buildTextChannelPanelFrame — schema validity", () => {
  test("emits a frame that passes CoViewCanonicalRenderFrameSchema", () => {
    const frame = buildTextChannelPanelFrame(fixtureInput());
    const parsed = CoViewCanonicalRenderFrameSchema.safeParse(frame);
    expect(parsed.success).toBe(true);
  });

  test("a minimal slice (no controls) is still schema-valid", () => {
    const frame = buildTextChannelPanelFrame({
      channelId: CHANNEL_ID,
      channelName: CHANNEL_NAME,
      message: { messageId: MESSAGE_ID, author: MSG_AUTHOR, timestamp: MSG_TIMESTAMP, body: MSG_BODY },
    });
    expect(CoViewCanonicalRenderFrameSchema.safeParse(frame).success).toBe(true);
    expect(frame.surfaceId).toBe(TEXT_CHANNEL_PANEL_SURFACE_ID);
  });
});

// ---------------------------------------------------------------------------
// Controls mirror — independent of viewer permissions
// ---------------------------------------------------------------------------

describe("buildTextChannelPanelFrame — controls mirror structurally", () => {
  test("every context-menu item and row action is a control node with NO value", () => {
    // The builder has no viewer/permission parameter at all — control existence
    // is decided purely by host UI, never by a viewer's entitlement.
    const frame = buildTextChannelPanelFrame(fixtureInput());
    const controlIds = ["btn-markread", "btn-copylink", "btn-delete", "act-react", "act-reply"];

    for (const id of controlIds) {
      const node = findNode(frame.root, id);
      expect(node).not.toBeNull();
      expect(node?.kind).toBe("control");
      expect(node?.attrs?.controlKind).toBeDefined();
      // A control carries no data value — present and unchanged, never gated away.
      expect(node !== null && "value" in node).toBe(false);
    }
  });

  test("host interaction state (open menu, hovered item/row) mirrors as-is", () => {
    const frame = buildTextChannelPanelFrame(fixtureInput());
    expect(findNode(frame.root, "context-menu")?.state).toEqual({ open: true });
    expect(findNode(frame.root, "btn-delete")?.state).toEqual({ hovered: true });
    expect(findNode(frame.root, "message-row")?.state).toEqual({ hovered: true });
  });

  test("visible control labels mirror as PUBLIC child text nodes (video-like explanation)", () => {
    const frame = buildTextChannelPanelFrame(fixtureInput());
    const expectedLabels: Record<string, string> = {
      "btn-markread-label": "Mark as read",
      "btn-copylink-label": "Copy link",
      "btn-delete-label": "Delete channel",
      "act-react-label": "React",
      "act-reply-label": "Reply",
    };
    for (const [labelId, text] of Object.entries(expectedLabels)) {
      const node = findNode(frame.root, labelId);
      expect(node?.kind).toBe("text");
      expect(node?.value).toEqual({ origin: "public", value: text });
    }
    // The label child lives UNDER its control — so a viewer sees what the host
    // is hovering ("Delete channel"), not merely that a menu item exists.
    const del = findNode(frame.root, "btn-delete");
    expect(del?.children?.map((c) => c.id)).toEqual(["btn-delete-label"]);
  });

  test("a control without a label has no label child (label is optional chrome)", () => {
    const frame = buildTextChannelPanelFrame({
      channelId: CHANNEL_ID,
      channelName: CHANNEL_NAME,
      message: { messageId: MESSAGE_ID, author: MSG_AUTHOR, timestamp: MSG_TIMESTAMP, body: MSG_BODY },
      contextMenuItems: [{ id: "btn-bare", controlKind: "menuitem" }],
    });
    const bare = findNode(frame.root, "btn-bare");
    expect(bare?.kind).toBe("control");
    expect(bare?.children).toBeUndefined();
    expect(findNode(frame.root, "btn-bare-label")).toBeNull();
  });

  test("control labels must be GENERIC chrome — no public value equals a protected string", () => {
    // Contract (documented on TextChannelControlInput.label): a control label is
    // ordinary affordance text and mirrors publicly. A protected resource name
    // (a channel/member name) is DATA and must travel as a gated slot value, not
    // a control label — otherwise it would leak as public. This guards the whole
    // frame: every public value must be generic chrome, never a protected string.
    const frame = buildTextChannelPanelFrame(fixtureInput());
    const publicValues: unknown[] = [];
    walk(frame.root, (n) => {
      if (n.value?.origin === "public") publicValues.push(n.value.value);
    });
    expect(publicValues.length).toBeGreaterThan(0);
    for (const v of publicValues) {
      expect(PROTECTED_STRINGS).not.toContain(v as string);
    }
  });
});

// ---------------------------------------------------------------------------
// Protected values — gated with correct policy/resource refs
// ---------------------------------------------------------------------------

describe("buildTextChannelPanelFrame — protected values are gated", () => {
  test("channel name is gated on channel.read with a channel resourceRef", () => {
    const frame = buildTextChannelPanelFrame(fixtureInput());
    const node = findNode(frame.root, TEXT_CHANNEL_PANEL_SLOTS.channelName);
    expect(node?.value).toEqual({
      origin: "gated",
      policyRef: "channel.read",
      resourceRef: { kind: "channel", channelId: CHANNEL_ID },
      placeholderShape: { mode: "synthetic" },
    });
  });

  test("author/timestamp/body are gated on channel.message.read with a message resourceRef", () => {
    const frame = buildTextChannelPanelFrame(fixtureInput());
    const expected: CoViewCanonicalValueRef = {
      origin: "gated",
      policyRef: "channel.message.read",
      resourceRef: { kind: "message", channelId: CHANNEL_ID, messageId: MESSAGE_ID },
      placeholderShape: { mode: "synthetic" },
    };
    for (const slot of [
      TEXT_CHANNEL_PANEL_SLOTS.messageAuthor,
      TEXT_CHANNEL_PANEL_SLOTS.messageTimestamp,
      TEXT_CHANNEL_PANEL_SLOTS.messageBody,
    ]) {
      expect(findNode(frame.root, slot)?.value).toEqual(expected);
    }
  });

  test("every registered protected slot passes validateCanonicalSlotValue", () => {
    const frame = buildTextChannelPanelFrame(fixtureInput());
    const surface = TEXT_CHANNEL_PANEL_REGISTRY.surfaces[TEXT_CHANNEL_PANEL_SURFACE_ID]!;
    expect(surface.slots.length).toBeGreaterThan(0);

    for (const slot of surface.slots) {
      // node.id === slotId is the CV-FOUND-2 projector convention this slice keeps.
      const node = findNode(frame.root, slot.slotId);
      expect(node).not.toBeNull();
      expect(node?.value).toBeDefined();
      const result = validateCanonicalSlotValue(
        TEXT_CHANNEL_PANEL_REGISTRY,
        TEXT_CHANNEL_PANEL_SURFACE_ID,
        slot.slotId,
        node!.value!,
      );
      expect(result).toEqual({ ok: true });
    }
  });

  test("gated values carry NO host-provided value (runtime-resolved; producerValueAllowed defaults false)", () => {
    const frame = buildTextChannelPanelFrame(fixtureInput());
    const surface = TEXT_CHANNEL_PANEL_REGISTRY.surfaces[TEXT_CHANNEL_PANEL_SURFACE_ID]!;

    for (const slot of surface.slots) {
      // No slot opts into host-provided values, so `gated.value` must be absent.
      expect(slot.producerValueAllowed === true).toBe(false);
      const value = findNode(frame.root, slot.slotId)?.value;
      expect(value?.origin).toBe("gated");
      expect(value && "value" in value).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Public chrome mirrors by default
// ---------------------------------------------------------------------------

describe("buildTextChannelPanelFrame — public chrome", () => {
  test("the channel-type glyph mirrors as public (generic chrome, not channel data)", () => {
    const frame = buildTextChannelPanelFrame(fixtureInput());
    const icon = findNode(frame.root, "channel-icon");
    expect(icon?.kind).toBe("icon");
    expect(icon?.value).toEqual({ origin: "public", value: "#" });
  });
});

// ---------------------------------------------------------------------------
// Local never appears; protected strings never cross into the frame
// ---------------------------------------------------------------------------

describe("buildTextChannelPanelFrame — wire safety", () => {
  test("no node carries origin: 'local' anywhere in the frame", () => {
    const frame = buildTextChannelPanelFrame(fixtureInput());
    for (const node of allNodes(frame.root)) {
      if (node.value !== undefined) {
        expect((node.value as { origin: string }).origin).not.toBe("local");
      }
    }
    // And nothing serializes a local origin either.
    expect(JSON.stringify(frame)).not.toContain('"local"');
  });

  test("the real protected strings never appear in the frame (producer is not the privacy authority)", () => {
    // The only non-gated data-bearing value is the public "#" glyph, which is
    // not one of the protected strings. Because the gated slots are
    // runtime-resolved, the real channel name / author / timestamp / body are
    // dropped entirely — they must be absent from the whole serialized frame.
    const frame = buildTextChannelPanelFrame(fixtureInput());
    const serialized = JSON.stringify(frame);
    for (const secret of PROTECTED_STRINGS) {
      expect(serialized).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-closed: widening a protected slot remains blocked
// ---------------------------------------------------------------------------

describe("buildTextChannelPanelFrame — widening stays blocked", () => {
  test("a deliberate public value on a registered protected slot is rejected (origin-widened)", () => {
    // Simulate a producer trying to widen the gated channel-name slot by shipping
    // a public value carrying the real name. The registry gate must refuse it.
    const widened: CoViewCanonicalValueRef = { origin: "public", value: CHANNEL_NAME };
    const result = validateCanonicalSlotValue(
      TEXT_CHANNEL_PANEL_REGISTRY,
      TEXT_CHANNEL_PANEL_SURFACE_ID,
      TEXT_CHANNEL_PANEL_SLOTS.channelName,
      widened,
    );
    expect(result).toEqual({ ok: false, reason: "origin-widened" });
  });

  test("a host-provided value on a gated slot is rejected (producer-value-not-allowed)", () => {
    // Even with the correct policy/resource shape, attaching a host value to a
    // runtime-resolved slot fails closed — proving producerValueAllowed: false.
    const withHostValue: CoViewCanonicalValueRef = {
      origin: "gated",
      policyRef: "channel.read",
      resourceRef: { kind: "channel", channelId: CHANNEL_ID },
      value: CHANNEL_NAME,
      placeholderShape: { mode: "synthetic" },
    };
    const result = validateCanonicalSlotValue(
      TEXT_CHANNEL_PANEL_REGISTRY,
      TEXT_CHANNEL_PANEL_SURFACE_ID,
      TEXT_CHANNEL_PANEL_SLOTS.channelName,
      withHostValue,
    );
    expect(result).toEqual({ ok: false, reason: "producer-value-not-allowed" });
  });
});
