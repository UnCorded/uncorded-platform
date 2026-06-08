// CoView projected render-tree viewer renderer — contract tests (CV-FOUND-5).
//
// These prove the website-side renderer honors the CoView projection contract:
//   - authorized and unauthorized projected frames resolve to the SAME structure
//     and the SAME control/menu nodes (control visibility is host-driven);
//   - unauthorized render output contains none of the protected strings;
//   - controls, menu items, and hover/open/focus state still render for an
//     unauthorized viewer;
//   - the renderer cannot introduce an unsafe attribute — it reads only the
//     allowlisted safe fields, so smuggled `href`/`src`/`style`/`onclick`/raw
//     keys never reach the view model;
//   - withheld/secret values never render real bytes, and `unsupported` never
//     echoes its (unproven-sensitivity) reason string.
//
// The renderer's input is a `CoViewProjectedRenderFrame` — the exact shape a
// viewer receives over the wire — so the fixtures are hand-built projected
// frames (no runtime/producer import keeps this confined to the website layer).

import { describe, expect, test } from "bun:test";
import type {
  CoViewBox,
  CoViewProjectedNode,
  CoViewProjectedRenderFrame,
  CoViewProjectedValue,
  CoViewSafeAttrs,
  JsonValue,
} from "@uncorded/protocol";

import {
  CO_VIEW_PROJECTED_VIEWER_ENABLED,
  resolveProjectedFrame,
  resolveProjectedNode,
  type SafeViewNode,
} from "./render-tree-viewer";

// ---------------------------------------------------------------------------
// Protected fixture data — these strings must NEVER appear in any output a
// viewer is not entitled to (and `secret`/`unsupported` text must never appear
// to anyone).
// ---------------------------------------------------------------------------

const CHANNEL_NAME = "leadership";
const MSG_AUTHOR = "John Doe";
const MSG_TIMESTAMP = "10:42 AM";
const MSG_BODY = "We need to review pricing before launch.";
const SECRET_BYTES = "sk-live-DEADBEEF-do-not-leak";
const UNSUPPORTED_REASON = "resolver-timeout while reading leadership pricing";

/** Strings carried by `gated` values — withheld from an unauthorized viewer. */
const GATED_STRINGS = [CHANNEL_NAME, MSG_AUTHOR, MSG_TIMESTAMP, MSG_BODY, "pricing"];

/** Public chrome — labels/glyphs that mirror to EVERY viewer regardless of perm. */
const PUBLIC_LABELS = ["#", "React", "Reply", "Mark as read", "Copy link", "Delete"];

const ZERO_BOX: CoViewBox = { x: 0, y: 0, width: 0, height: 0 };
function box(x: number, y: number, w: number, h: number): CoViewBox {
  return { x, y, width: w, height: h };
}

// ---------------------------------------------------------------------------
// Frame builders. A single builder emits both the authorized and unauthorized
// frame so their structure is identical *by construction* — only the per-node
// value payload of a `gated` slot differs. That is exactly the host→viewer
// contract: one structure, per-viewer values.
// ---------------------------------------------------------------------------

type ViewerMode = "authorized" | "unauthorized";

/** A gated value: the real bytes for an authorized viewer, a placeholder else. */
function gated(mode: ViewerMode, value: JsonValue): CoViewProjectedValue {
  return mode === "authorized"
    ? { state: "visible", value }
    : { state: "withheld", placeholderShape: { mode: "synthetic", width: 80, height: 12 } };
}

/** A public value: the same visible content for everyone. */
function pub(value: JsonValue): CoViewProjectedValue {
  return { state: "visible", value };
}

/** A control node (button/menuitem) with a public text label child. Always
 *  rendered; carries no data value of its own. */
function control(
  id: string,
  controlKind: NonNullable<CoViewSafeAttrs["controlKind"]>,
  label: string,
  extra?: Partial<CoViewProjectedNode>,
): CoViewProjectedNode {
  return {
    id,
    kind: "control",
    box: ZERO_BOX,
    attrs: { controlKind, classTokens: ["control"] },
    children: [{ id: `${id}-label`, kind: "text", box: ZERO_BOX, value: pub(label) }],
    ...extra,
  };
}

function buildFrame(mode: ViewerMode): CoViewProjectedRenderFrame {
  return {
    surfaceId: "text-channel-panel",
    root: {
      id: "root",
      kind: "element",
      box: box(0, 0, 400, 600),
      attrs: { classTokens: ["panel"] },
      children: [
        // Channel header: a public type glyph + a gated channel name.
        {
          id: "header",
          kind: "element",
          box: box(0, 0, 400, 32),
          attrs: { classTokens: ["header"] },
          children: [
            { id: "channel-icon", kind: "icon", box: box(4, 8, 16, 16), value: pub("#") },
            { id: "channel-name", kind: "text", box: box(24, 8, 120, 16), value: gated(mode, CHANNEL_NAME) },
          ],
        },
        // Message row — hovered, with gated author/timestamp/body.
        {
          id: "msg-row",
          kind: "element",
          box: box(0, 40, 400, 60),
          attrs: { classTokens: ["message"] },
          state: { hovered: true },
          children: [
            { id: "msg-author", kind: "text", box: box(8, 44, 100, 16), value: gated(mode, MSG_AUTHOR) },
            { id: "msg-timestamp", kind: "text", box: box(112, 44, 60, 16), value: gated(mode, MSG_TIMESTAMP) },
            { id: "msg-body", kind: "text", box: box(8, 62, 380, 32), value: gated(mode, MSG_BODY) },
            // A never-visible secret avatar token — placeholder for EVERYONE.
            {
              id: "msg-secret",
              kind: "image",
              box: box(360, 44, 24, 24),
              value: { state: "secret", placeholderShape: { mode: "synthetic", width: 24, height: 24 } },
            },
            // Row action controls (public labels, always rendered).
            {
              id: "row-actions",
              kind: "element",
              box: box(300, 44, 90, 16),
              attrs: { classTokens: ["actions"] },
              children: [control("act-react", "button", "React"), control("act-reply", "button", "Reply")],
            },
          ],
        },
        // Context menu — open, with menu items (one disabled). Mirrors for all.
        {
          id: "ctx-menu",
          kind: "element",
          box: box(120, 100, 160, 90),
          attrs: { classTokens: ["menu"], ariaRole: "menu", ariaExpanded: true },
          state: { open: true },
          children: [
            control("mi-markread", "menuitem", "Mark as read"),
            control("mi-copylink", "menuitem", "Copy link"),
            control("mi-delete", "menuitem", "Delete", { state: { disabled: true } }),
          ],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function findNode(root: SafeViewNode, id: string): SafeViewNode | undefined {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

function walk(root: SafeViewNode): SafeViewNode[] {
  return [root, ...root.children.flatMap(walk)];
}

/** All rendered display text across the tree (placeholders contribute none). */
function collectText(root: SafeViewNode): string[] {
  return walk(root)
    .map((n) => (n.content.kind === "text" ? n.content.text : null))
    .filter((t): t is string => t !== null);
}

/** Structure-only projection: drop every node's content slot, keep the rest. */
function stripContent(node: SafeViewNode): Omit<SafeViewNode, "content" | "children"> & {
  children: ReturnType<typeof stripContent>[];
} {
  const { content: _content, children, ...rest } = node;
  return { ...rest, children: children.map(stripContent) };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("CoView projected viewer renderer", () => {
  test("ships disabled — not wired into the live app", () => {
    expect(CO_VIEW_PROJECTED_VIEWER_ENABLED).toBe(false);
  });

  test("authorized and unauthorized frames resolve to identical structure", () => {
    const authorized = resolveProjectedFrame(buildFrame("authorized"));
    const unauthorized = resolveProjectedFrame(buildFrame("unauthorized"));

    expect(authorized.surfaceId).toBe(unauthorized.surfaceId);
    // Structure (id/kind/tag/attrs/state/box/children) is byte-identical; only
    // the per-node content slot may differ between viewers.
    expect(stripContent(unauthorized.root)).toEqual(stripContent(authorized.root));
  });

  test("the same control / menu nodes exist for both viewers", () => {
    const authorized = resolveProjectedFrame(buildFrame("authorized")).root;
    const unauthorized = resolveProjectedFrame(buildFrame("unauthorized")).root;

    const controlIds = ["act-react", "act-reply", "mi-markread", "mi-copylink", "mi-delete"];
    for (const id of controlIds) {
      const a = findNode(authorized, id);
      const u = findNode(unauthorized, id);
      expect(a).toBeDefined();
      expect(u).toBeDefined();
      expect(u?.kind).toBe("control");
      // Control labels are public — they render verbatim for the unauthorized
      // viewer too (control visibility is a host decision, not an entitlement).
      expect(findNode(unauthorized, `${id}-label`)?.content).toEqual(a!.children[0]!.content);
    }
  });

  test("controls, menu items, and hover/open/disabled state render for an unauthorized viewer", () => {
    const root = resolveProjectedFrame(buildFrame("unauthorized")).root;

    // Hover state on the message row mirrors through.
    expect(findNode(root, "msg-row")?.state.hovered).toBe(true);
    // Open menu state + aria mirror through.
    const menu = findNode(root, "ctx-menu");
    expect(menu?.state.open).toBe(true);
    expect(menu?.aria.role).toBe("menu");
    expect(menu?.aria.expanded).toBe(true);
    // Disabled menu item still renders, and its disabled state is mirrored.
    const del = findNode(root, "mi-delete");
    expect(del).toBeDefined();
    expect(del?.state.disabled).toBe(true);
    // Public control labels are visible to the unauthorized viewer.
    const labels = collectText(root);
    for (const label of PUBLIC_LABELS) expect(labels).toContain(label);
  });

  test("unauthorized output contains none of the protected strings", () => {
    const frame = resolveProjectedFrame(buildFrame("unauthorized"));
    const serialized = JSON.stringify(frame);
    for (const secret of GATED_STRINGS) {
      expect(serialized).not.toContain(secret);
    }
    // And no node renders a gated value as display text.
    const texts = collectText(frame.root);
    for (const secret of GATED_STRINGS) {
      expect(texts).not.toContain(secret);
    }
  });

  test("authorized viewer sees the real gated values", () => {
    const root = resolveProjectedFrame(buildFrame("authorized")).root;
    expect(findNode(root, "channel-name")?.content).toEqual({ kind: "text", text: CHANNEL_NAME });
    expect(findNode(root, "msg-author")?.content).toEqual({ kind: "text", text: MSG_AUTHOR });
    expect(findNode(root, "msg-body")?.content).toEqual({ kind: "text", text: MSG_BODY });
    // Public glyph is visible to everyone.
    expect(findNode(root, "channel-icon")?.content).toEqual({ kind: "text", text: "#" });
  });

  test("withheld values render a deterministic placeholder, never bytes", () => {
    const root = resolveProjectedFrame(buildFrame("unauthorized")).root;
    const name = findNode(root, "channel-name");
    expect(name?.content.kind).toBe("placeholder");
    expect(name?.content).toEqual({
      kind: "placeholder",
      placeholder: { reason: "withheld", mode: "synthetic", width: 80, height: 12 },
    });
    // The placeholder carries no `text` field at all.
    expect(JSON.stringify(name?.content)).not.toContain("text");
  });

  test("secret values render a placeholder and never the real bytes — for any viewer", () => {
    for (const mode of ["authorized", "unauthorized"] as const) {
      const root = resolveProjectedFrame(buildFrame(mode)).root;
      const secret = findNode(root, "msg-secret");
      expect(secret).toBeDefined();
      expect(secret!.content.kind).toBe("placeholder");
      expect((secret!.content as { placeholder: { reason: string } }).placeholder.reason).toBe("secret");
    }
    // The secret bytes never appear, even though the fixture references them.
    expect(SECRET_BYTES.length).toBeGreaterThan(0);
    const authorized = JSON.stringify(resolveProjectedFrame(buildFrame("authorized")));
    const unauthorized = JSON.stringify(resolveProjectedFrame(buildFrame("unauthorized")));
    expect(authorized).not.toContain(SECRET_BYTES);
    expect(unauthorized).not.toContain(SECRET_BYTES);
  });

  test("unsupported values render a safe placeholder and never echo the reason", () => {
    const node: CoViewProjectedNode = {
      id: "n",
      kind: "text",
      box: ZERO_BOX,
      value: { state: "unsupported", reason: UNSUPPORTED_REASON },
    };
    const resolved = resolveProjectedNode(node);
    expect(resolved.content).toEqual({
      kind: "placeholder",
      placeholder: { reason: "unsupported", mode: "synthetic" },
    });
    // The reason string (and any sensitive-looking fragment of it) is dropped.
    const serialized = JSON.stringify(resolved);
    expect(serialized).not.toContain("resolver-timeout");
    expect(serialized).not.toContain("pricing");
  });

  test("node identity and child order are preserved", () => {
    const root = resolveProjectedFrame(buildFrame("authorized")).root;
    const actions = findNode(root, "row-actions");
    expect(actions?.children.map((c) => c.id)).toEqual(["act-react", "act-reply"]);
    const menu = findNode(root, "ctx-menu");
    expect(menu?.children.map((c) => c.id)).toEqual(["mi-markread", "mi-copylink", "mi-delete"]);
  });
});

describe("renderer attribute safety", () => {
  test("only allowlisted safe attrs survive — smuggled raw attrs cannot be introduced", () => {
    // A malformed node carrying raw HTML attributes and junk keys. The renderer
    // must read ONLY the allowlist and drop everything else.
    const smuggled = {
      id: "x",
      kind: "element",
      box: ZERO_BOX,
      attrs: {
        classTokens: ["real", 123, { evil: true }],
        ariaRole: "button",
        // none of these are on the safe-attr allowlist:
        href: "https://evil.example/track",
        src: "javascript:alert(1)",
        style: "background:url(https://evil.example)",
        title: "secret tooltip",
        onclick: "steal()",
        "data-token": SECRET_BYTES,
      },
      // smuggled top-level junk + a smuggled value-bearing field:
      innerHTML: "<script>x</script>",
      dangerous: { nested: SECRET_BYTES },
    } as unknown as CoViewProjectedNode;

    const resolved = resolveProjectedNode(smuggled);

    // Class tokens: only the string token survives; 123 and the object are dropped.
    expect(resolved.classTokens).toEqual(["real"]);
    expect(resolved.aria).toEqual({ role: "button" });
    // The resolved node exposes exactly the safe shape — no smuggled keys.
    expect(Object.keys(resolved).sort()).toEqual(
      ["aria", "box", "children", "classTokens", "content", "id", "kind", "state", "tag"].sort(),
    );

    // None of the smuggled payloads survive serialization.
    const serialized = JSON.stringify(resolved);
    for (const needle of [
      "evil.example",
      "javascript:",
      "onclick",
      "innerHTML",
      "<script",
      "secret tooltip",
      SECRET_BYTES,
    ]) {
      expect(serialized).not.toContain(needle);
    }
  });

  test("ariaRole accepts only structural role tokens, not arbitrary text", () => {
    const resolved = resolveProjectedNode({
      id: "role-leak",
      kind: "element",
      box: ZERO_BOX,
      attrs: { ariaRole: SECRET_BYTES },
    });

    expect(resolved.aria.role).toBeUndefined();
    expect(JSON.stringify(resolved)).not.toContain(SECRET_BYTES);
  });

  test("node kinds resolve to a fixed, safe tag set — never img/canvas/script", () => {
    const kinds = [
      { kind: "element", expected: "div" },
      { kind: "text", expected: "span" },
      { kind: "icon", expected: "span" },
      { kind: "image", expected: "div" },
      { kind: "canvas", expected: "div" },
    ] as const;
    for (const { kind, expected } of kinds) {
      const resolved = resolveProjectedNode({ id: kind, kind, box: ZERO_BOX });
      expect(resolved.tag).toBe(expected);
    }
    // A button control becomes a real <button>; other controls stay a <div>.
    expect(
      resolveProjectedNode({ id: "b", kind: "control", box: ZERO_BOX, attrs: { controlKind: "button" } }).tag,
    ).toBe("button");
    expect(
      resolveProjectedNode({ id: "m", kind: "control", box: ZERO_BOX, attrs: { controlKind: "menuitem" } }).tag,
    ).toBe("div");
  });

  test("a visible non-primitive value renders nothing rather than dumping a structure", () => {
    const node: CoViewProjectedNode = {
      id: "obj",
      kind: "text",
      box: ZERO_BOX,
      value: { state: "visible", value: { nested: "data", arr: [1, 2] } },
    };
    const resolved = resolveProjectedNode(node);
    expect(resolved.content).toEqual({ kind: "empty" });
    expect(JSON.stringify(resolved)).not.toContain("nested");
  });
});
