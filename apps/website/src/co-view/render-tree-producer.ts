// CoView render-tree producer — text-channel panel slice (CV-FOUND-3).
//
// This is the website (host) producer for ONE narrow real surface: a private
// text-channel panel, the first vertical slice the foundation plan recommends
// (`docs/coview/foundation-plan.md` §6). It turns an explicit description of a
// host-rendered text-channel panel into a single `CoViewCanonicalRenderFrame`
// the runtime projection core (CV-FOUND-2) can validate and project per viewer.
//
// The model (foundation-plan §0, §2):
//   control visibility = host permissions   (controls/buttons/menus mirror as-is)
//   data visibility     = viewer permissions (data-bearing values project per viewer)
//
// What this module does and does NOT do:
//   - It is a PURE mapper: explicit input → canonical frame. It reads no live app
//     state and touches no DOM. Real text-channel content lives inside a
//     sandboxed plugin iframe (see `components/channel-view.tsx`), so the shell
//     cannot serialize it directly; instead the slice is described by typed
//     input and proven against the CV-FOUND-1 schema + registry with realistic
//     fixtures (foundation-plan §6, CV-FOUND-3 row of §7).
//   - It is NOT wired into the live CoView producer/broadcast path. The legacy
//     shell-state producer (`producer.ts`) is untouched. This builder is an
//     exported helper gated behind `CO_VIEW_RENDER_TREE_PRODUCER_ENABLED` (false)
//     until CV-FOUND-4 wires the broadcast path + viewer renderer.
//
// SECURITY — the producer is NOT the privacy authority (foundation-plan §5,
// §4.9). Two structural rules this builder enforces:
//   1. Protected channel/message values are emitted as `gated` refs carrying
//      ONLY `policyRef` + `resourceRef` + `placeholderShape` — never the real
//      bytes. The registered slots default to `producerValueAllowed: false`, so
//      the value is runtime-resolved per viewer; a host-provided value would be
//      rejected by `validateCanonicalSlotValue`. The builder therefore drops the
//      real author/timestamp/body/channel-name strings it is handed.
//   2. The canonical wire value type (`CoViewCanonicalValueRef`) has no `local`
//      arm, so nothing this builder emits can carry `origin: "local"`.
//
// Controls (context-menu items, hover actions) mirror structurally: they exist
// because the host UI rendered them and carry no data value. Viewer permissions
// never recompute which controls exist (foundation-plan §2.1, §5.1).

import type {
  CoViewBox,
  CoViewCanonicalRenderFrame,
  CoViewCanonicalValueRef,
  CoViewControlKind,
  CoViewNodeState,
  CoViewRenderNode,
  CoViewSafeAttrs,
  CoViewSurfaceRegistry,
} from "@uncorded/protocol";

// ---------------------------------------------------------------------------
// Feature flag (foundation-plan §7, CV-FOUND-3: "behind a flag")
// ---------------------------------------------------------------------------

/**
 * Gate for the render-tree producer. `false` until CV-FOUND-4 wires the runtime
 * broadcast path + viewer renderer. No live code path consumes the builder yet —
 * this constant exists so the eventual wiring has a single switch and so callers
 * cannot accidentally treat the render-tree path as live before it ships.
 */
export const CO_VIEW_RENDER_TREE_PRODUCER_ENABLED = false;

// ---------------------------------------------------------------------------
// Surface id + slot ids (foundation-plan §4.9)
// ---------------------------------------------------------------------------

/**
 * Registered surface id for the text-channel panel slice. Matches the id the
 * CV-FOUND-2 runtime projection tests already use, so a frame from this builder
 * is forward-compatible with the runtime projector without a translation layer.
 */
export const TEXT_CHANNEL_PANEL_SURFACE_ID = "text-channel-panel";

/**
 * Slot ids for the slice. Each protected render node's `id` is its slot id (the
 * convention the CV-FOUND-2 projector relies on: it looks a slot up by node id),
 * so a node `channel-name` is validated/projected against the `channel-name`
 * slot. Per-message identity rides on the gated value's `resourceRef`
 * (`messageId`), not the node id — which is why one stable representative row is
 * enough to prove the model (foundation-plan §6).
 */
export const TEXT_CHANNEL_PANEL_SLOTS = {
  channelName: "channel-name",
  messageAuthor: "msg-author",
  messageTimestamp: "msg-timestamp",
  messageBody: "msg-body",
} as const;

// Non-slot node ids — structural / public chrome that is not a registered
// protected slot.
const NODE_IDS = {
  panel: "panel",
  header: "header",
  channelIcon: "channel-icon",
  messageList: "message-list",
  messageRow: "message-row",
  rowActions: "row-actions",
  contextMenu: "context-menu",
} as const;

// ---------------------------------------------------------------------------
// Surface registry (foundation-plan §4.9) — colocated with the producer
// ---------------------------------------------------------------------------

/**
 * The surface registry for the text-channel panel slice. Four protected slots,
 * all `gated` and all runtime-resolved (`producerValueAllowed` omitted ⇒ `false`,
 * foundation-plan §4.9, §5.8):
 *
 *  - `channel-name`  → `channel.read`         (resource: the channel)
 *  - `msg-author`    → `channel.message.read` (resource: the message)
 *  - `msg-timestamp` → `channel.message.read` (resource: the message)
 *  - `msg-body`      → `channel.message.read` (resource: the message)
 *
 * Every gated slot declares its `policyRef`, requires a `resourceRef`, and
 * accepts only the `synthetic` placeholder mode — a same-intent skeleton that
 * leaks no real size/existence (a non-rect placeholder; `preserve-host-rect`
 * would require explicit `sizeLeakAccepted` and is intentionally not accepted
 * here). The channel-type icon and the controls are NOT registered: ordinary
 * host-rendered chrome mirrors by default (foundation-plan §0) and controls
 * carry no data value at all.
 */
export const TEXT_CHANNEL_PANEL_REGISTRY: CoViewSurfaceRegistry = {
  surfaces: {
    [TEXT_CHANNEL_PANEL_SURFACE_ID]: {
      surfaceId: TEXT_CHANNEL_PANEL_SURFACE_ID,
      slots: [
        {
          slotId: TEXT_CHANNEL_PANEL_SLOTS.channelName,
          origin: "gated",
          policyRef: "channel.read",
          resourceRefRequired: true,
          placeholderModes: ["synthetic"],
        },
        {
          slotId: TEXT_CHANNEL_PANEL_SLOTS.messageAuthor,
          origin: "gated",
          policyRef: "channel.message.read",
          resourceRefRequired: true,
          placeholderModes: ["synthetic"],
        },
        {
          slotId: TEXT_CHANNEL_PANEL_SLOTS.messageTimestamp,
          origin: "gated",
          policyRef: "channel.message.read",
          resourceRefRequired: true,
          placeholderModes: ["synthetic"],
        },
        {
          slotId: TEXT_CHANNEL_PANEL_SLOTS.messageBody,
          origin: "gated",
          policyRef: "channel.message.read",
          resourceRefRequired: true,
          placeholderModes: ["synthetic"],
        },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Builder input (explicit, pure — no DOM, no live app state)
// ---------------------------------------------------------------------------

/**
 * A host-rendered control (context-menu item, hover action). Controls mirror
 * structurally and carry NO data value on the control node itself — they exist
 * because the host UI rendered them, and viewer permissions never recompute
 * their existence (foundation-plan §2.1, §5.1). The host's interaction state
 * (hovered/disabled/…) is part of the host UI and mirrors as-is; it grants the
 * viewer no authority to execute.
 *
 * The control's visible `label` is ordinary UI chrome: it mirrors as a `public`
 * child text node so a viewer can see WHAT the host is hovering/clicking, not
 * merely that "a menu item exists" (the video-like-explanation goal,
 * foundation-plan §0). The label must be GENERIC affordance text ("Delete
 * channel", "Copy link", "Reply") — a protected resource name (a channel name, a
 * member name) is data, belongs in a `gated` slot, and must NEVER be passed as a
 * control label (which would mirror it as public and leak it).
 */
export interface TextChannelControlInput {
  /** Stable node id, unique within the panel. */
  id: string;
  controlKind: CoViewControlKind;
  /** Generic visible affordance label — mirrors as public chrome. NOT for
   *  protected resource names (those are gated values, not control labels). */
  label?: string;
  /** Presentational class tokens (allowlisted safe attr) — e.g. ["item","danger"]. */
  classTokens?: string[];
  /** Host-rendered interaction state mirrored as-is. */
  state?: CoViewNodeState;
  /** Optional layout box; defaults to a zero rect. */
  box?: CoViewBox;
}

/**
 * The single representative message row of the slice. The real `author` /
 * `timestamp` / `body` strings are provided for realism, but because the
 * registered slots are runtime-resolved (`producerValueAllowed: false`), the
 * builder DROPS them — the emitted frame carries only the message `resourceRef`.
 * This is the point: the producer holds the real data yet is structurally
 * incapable of being the privacy authority for it.
 */
export interface TextChannelMessageInput {
  /** Stable message id; becomes the `messageId` in every message `resourceRef`. */
  messageId: string;
  /** Real author display name (protected; dropped from the frame). */
  author: string;
  /** Real timestamp display string (protected; dropped from the frame). */
  timestamp: string;
  /** Real message body (protected; dropped from the frame). */
  body: string;
  /** Whether the host hovered this row (mirrors as-is). */
  hovered?: boolean;
  /** Optional per-node layout boxes. */
  boxes?: {
    row?: CoViewBox;
    author?: CoViewBox;
    timestamp?: CoViewBox;
    body?: CoViewBox;
  };
}

/**
 * The explicit description of a host-rendered text-channel panel. A pure mapper
 * input — every field the builder needs to emit the canonical frame, with no
 * dependency on live shell state or the DOM.
 */
export interface TextChannelPanelInput {
  /** Channel id; becomes the `channelId` in the channel + message resource refs. */
  channelId: string;
  /** Real channel name (protected; dropped from the frame). */
  channelName: string;
  /** Generic text-channel glyph shown in the header (public chrome). */
  channelIconGlyph?: string;
  /** The single representative message row. */
  message: TextChannelMessageInput;
  /** Optional hover-revealed action controls on the message row. */
  rowActions?: TextChannelControlInput[];
  /** Whether the channel/message context menu is open (mirrors as-is). */
  contextMenuOpen?: boolean;
  /** Context-menu item controls (e.g. Mark as read / Copy link / Delete channel). */
  contextMenuItems?: TextChannelControlInput[];
}

// ---------------------------------------------------------------------------
// Internal node helpers
// ---------------------------------------------------------------------------

const ZERO_BOX: CoViewBox = { x: 0, y: 0, width: 0, height: 0 };

/** Build a gated value ref for a protected slot — NEVER carries the real value
 *  (slots are runtime-resolved; the value is resolved per viewer downstream). */
function gatedChannelValue(channelId: string): CoViewCanonicalValueRef {
  return {
    origin: "gated",
    policyRef: "channel.read",
    resourceRef: { kind: "channel", channelId },
    placeholderShape: { mode: "synthetic" },
  };
}

function gatedMessageValue(channelId: string, messageId: string): CoViewCanonicalValueRef {
  return {
    origin: "gated",
    policyRef: "channel.message.read",
    resourceRef: { kind: "message", channelId, messageId },
    placeholderShape: { mode: "synthetic" },
  };
}

/** Assemble a render node, omitting optional fields that are absent so the node
 *  stays structurally minimal under `exactOptionalPropertyTypes`. */
function makeNode(node: {
  id: string;
  kind: CoViewRenderNode["kind"];
  box: CoViewBox;
  role?: string;
  state?: CoViewNodeState;
  attrs?: CoViewSafeAttrs;
  value?: CoViewCanonicalValueRef;
  children?: CoViewRenderNode[];
}): CoViewRenderNode {
  return {
    id: node.id,
    kind: node.kind,
    box: node.box,
    ...(node.role !== undefined ? { role: node.role } : {}),
    ...(node.state !== undefined ? { state: node.state } : {}),
    ...(node.attrs !== undefined ? { attrs: node.attrs } : {}),
    ...(node.value !== undefined ? { value: node.value } : {}),
    ...(node.children !== undefined ? { children: node.children } : {}),
  };
}

/**
 * A control node: `control` kind, control attrs, and NO value on the control
 * itself (control existence is host UI, never a data value). A generic visible
 * `label`, when present, mirrors as a `public` child text node (`${id}-label`)
 * so the viewer sees the affordance text — ordinary chrome, not protected data.
 */
function makeControlNode(control: TextChannelControlInput): CoViewRenderNode {
  const attrs: CoViewSafeAttrs = {
    controlKind: control.controlKind,
    ...(control.classTokens !== undefined ? { classTokens: control.classTokens } : {}),
  };
  const children =
    control.label !== undefined
      ? [
          makeNode({
            id: `${control.id}-label`,
            kind: "text",
            box: ZERO_BOX,
            value: { origin: "public", value: control.label },
          }),
        ]
      : undefined;
  return makeNode({
    id: control.id,
    kind: "control",
    box: control.box ?? ZERO_BOX,
    attrs,
    ...(control.state !== undefined ? { state: control.state } : {}),
    ...(children !== undefined ? { children } : {}),
  });
}

// ---------------------------------------------------------------------------
// Builder (foundation-plan §6) — explicit input → canonical frame
// ---------------------------------------------------------------------------

/**
 * Build the canonical CoView render frame for a text-channel panel slice.
 *
 * Structure emitted:
 *   panel
 *   ├─ header
 *   │  ├─ channel-icon   (icon,  public glyph — generic chrome, mirrors)
 *   │  └─ channel-name   (text,  GATED channel.read — value runtime-resolved)
 *   ├─ message-list
 *   │  └─ message-row    (element, host hover state)
 *   │     ├─ msg-author    (text, GATED channel.message.read)
 *   │     ├─ msg-timestamp (text, GATED channel.message.read)
 *   │     ├─ msg-body      (text, GATED channel.message.read)
 *   │     └─ row-actions   (element) → control nodes (no value; public label child)
 *   └─ context-menu      (element, host open state) → control nodes (no value; public label child)
 *
 * Product decision (foundation-plan open question §11.2): the channel-*type*
 * glyph (the `#` text-channel icon) is generic platform chrome — identical for
 * every text channel and revealing no channel identity — so it travels as
 * `public`. The channel *name* is the data and is `gated`.
 *
 * The returned frame is structurally valid against `CoViewCanonicalRenderFrameSchema`
 * and every protected node passes `validateCanonicalSlotValue` against
 * `TEXT_CHANNEL_PANEL_REGISTRY`. The real `channelName` / `author` / `timestamp`
 * / `body` strings are intentionally NOT present anywhere in the frame.
 */
export function buildTextChannelPanelFrame(
  input: TextChannelPanelInput,
): CoViewCanonicalRenderFrame {
  const { channelId, message } = input;
  const boxes = message.boxes ?? {};

  // --- Header: public icon + gated channel name -------------------------
  const headerChildren: CoViewRenderNode[] = [
    makeNode({
      id: NODE_IDS.channelIcon,
      kind: "icon",
      box: ZERO_BOX,
      // Generic text-channel glyph — public chrome, mirrors to every viewer.
      value: { origin: "public", value: input.channelIconGlyph ?? "#" },
    }),
    makeNode({
      id: TEXT_CHANNEL_PANEL_SLOTS.channelName,
      kind: "text",
      box: ZERO_BOX,
      value: gatedChannelValue(channelId),
    }),
  ];

  // --- Message row: gated author/timestamp/body + control actions -------
  const rowChildren: CoViewRenderNode[] = [
    makeNode({
      id: TEXT_CHANNEL_PANEL_SLOTS.messageAuthor,
      kind: "text",
      box: boxes.author ?? ZERO_BOX,
      value: gatedMessageValue(channelId, message.messageId),
    }),
    makeNode({
      id: TEXT_CHANNEL_PANEL_SLOTS.messageTimestamp,
      kind: "text",
      box: boxes.timestamp ?? ZERO_BOX,
      value: gatedMessageValue(channelId, message.messageId),
    }),
    makeNode({
      id: TEXT_CHANNEL_PANEL_SLOTS.messageBody,
      kind: "text",
      box: boxes.body ?? ZERO_BOX,
      value: gatedMessageValue(channelId, message.messageId),
    }),
  ];

  const rowActions = input.rowActions ?? [];
  if (rowActions.length > 0) {
    rowChildren.push(
      makeNode({
        id: NODE_IDS.rowActions,
        kind: "element",
        box: ZERO_BOX,
        role: "toolbar",
        children: rowActions.map(makeControlNode),
      }),
    );
  }

  const messageRow = makeNode({
    id: NODE_IDS.messageRow,
    kind: "element",
    box: boxes.row ?? ZERO_BOX,
    ...(message.hovered ? { state: { hovered: true } } : {}),
    children: rowChildren,
  });

  // --- Panel children: header, message list, optional context menu ------
  const panelChildren: CoViewRenderNode[] = [
    makeNode({ id: NODE_IDS.header, kind: "element", box: ZERO_BOX, children: headerChildren }),
    makeNode({
      id: NODE_IDS.messageList,
      kind: "element",
      box: ZERO_BOX,
      children: [messageRow],
    }),
  ];

  const contextMenuItems = input.contextMenuItems ?? [];
  if (contextMenuItems.length > 0) {
    panelChildren.push(
      makeNode({
        id: NODE_IDS.contextMenu,
        kind: "element",
        box: ZERO_BOX,
        attrs: { ariaRole: "menu" },
        ...(input.contextMenuOpen ? { state: { open: true } } : {}),
        children: contextMenuItems.map(makeControlNode),
      }),
    );
  }

  return {
    surfaceId: TEXT_CHANNEL_PANEL_SURFACE_ID,
    root: makeNode({
      id: NODE_IDS.panel,
      kind: "element",
      box: ZERO_BOX,
      role: "region",
      children: panelChildren,
    }),
  };
}
