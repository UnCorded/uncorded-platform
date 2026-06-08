// CoView render-tree projection core (CV-FOUND-2) focused tests.
//
// The product invariant under test is the projection boundary:
//   control visibility = host permissions   (controls/buttons/menus mirror)
//   data visibility     = viewer permissions (values project per viewer)
//
// A real registry + the CV-FOUND-1 schema run exactly as in production; only the
// value authority is mocked (per slot allow/deny) so each test pins entitlement
// deterministically and asserts on what crosses the projected wire.

import { describe, expect, test } from "bun:test";
import type {
  CoViewCanonicalRenderFrame,
  CoViewProjectedNode,
  CoViewSurfaceRegistry,
  ResolvedPluginResourceValue,
  ViewerContext,
} from "@uncorded/protocol";
import {
  projectCanonicalRenderFrame,
  type CoViewGatedResolveRequest,
  type CoViewValueResolver,
} from "./render-tree-projection";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SURFACE = "text-channel-panel";

// Real, protected bytes — assertions below prove these never cross an
// unauthorized viewer's wire.
const CHANNEL_NAME = "leadership";
const MESSAGE_BODY = "We need to review pricing before launch.";
const SECRET_BYTES = "tok_live_should_never_travel";

const VERSIONS = { resourceAclVersion: 1, resourcePermissionVersion: 1 } as const;

function box(): { x: number; y: number; width: number; height: number } {
  return { x: 0, y: 0, width: 10, height: 10 };
}

function viewer(userId: string): ViewerContext {
  return { userId, serverId: "srv-1" };
}

/**
 * Registry for the slice: a private channel panel with two gated value slots
 * (channel name + message body), both runtime-resolved (producerValueAllowed
 * defaults to false). `msg-author` is intentionally NOT registered — ordinary
 * public content that must mirror by default.
 */
const REGISTRY: CoViewSurfaceRegistry = {
  surfaces: {
    [SURFACE]: {
      surfaceId: SURFACE,
      slots: [
        {
          slotId: "channel-name",
          origin: "gated",
          policyRef: "channel.read",
          resourceRefRequired: true,
          placeholderModes: ["synthetic"],
        },
        {
          slotId: "msg-text",
          origin: "gated",
          policyRef: "channel.message.read",
          resourceRefRequired: true,
          placeholderModes: ["synthetic"],
        },
      ],
    },
  },
};

/**
 * One canonical host render frame: a private channel panel. The host hovered a
 * message row and opened its context menu. Controls carry NO value (they exist
 * because the host UI rendered them); the channel name and message body are
 * gated; an author label is public; a token is secret.
 *
 * Fresh per call so a test never mutates another's fixture.
 */
function buildPanelFrame(): CoViewCanonicalRenderFrame {
  return {
    surfaceId: SURFACE,
    root: {
      id: "panel",
      kind: "element",
      box: box(),
      children: [
        {
          id: "header",
          kind: "element",
          box: box(),
          children: [
            { id: "channel-icon", kind: "icon", box: box() },
            {
              id: "channel-name",
              kind: "text",
              box: box(),
              value: {
                origin: "gated",
                policyRef: "channel.read",
                resourceRef: { kind: "channel", channelId: "c1" },
                placeholderShape: { mode: "synthetic" },
              },
            },
          ],
        },
        {
          id: "row1",
          kind: "element",
          box: box(),
          state: { hovered: true },
          children: [
            {
              id: "msg-author",
              kind: "text",
              box: box(),
              // Public, unregistered — ordinary content, mirrors by default.
              value: { origin: "public", value: "John" },
            },
            {
              id: "msg-text",
              kind: "text",
              box: box(),
              value: {
                origin: "gated",
                policyRef: "channel.message.read",
                resourceRef: { kind: "message", channelId: "c1", messageId: "m1" },
                placeholderShape: { mode: "synthetic" },
              },
            },
            {
              id: "secret-token",
              kind: "text",
              box: box(),
              value: { origin: "secret", placeholderShape: { mode: "absent" } },
            },
          ],
        },
        {
          id: "menu",
          kind: "element",
          box: box(),
          state: { open: true },
          children: [
            {
              id: "btn-markread",
              kind: "control",
              box: box(),
              attrs: { controlKind: "menuitem", classTokens: ["item"] },
            },
            {
              id: "btn-delete",
              kind: "control",
              box: box(),
              state: { hovered: true },
              attrs: { controlKind: "menuitem", classTokens: ["item", "danger"] },
            },
          ],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Mock value authority
// ---------------------------------------------------------------------------

interface MockResolver {
  resolver: CoViewValueResolver;
  calls: CoViewGatedResolveRequest[];
}

function makeResolver(
  behavior: (req: CoViewGatedResolveRequest) => ResolvedPluginResourceValue,
): MockResolver {
  const calls: CoViewGatedResolveRequest[] = [];
  return {
    calls,
    resolver: {
      resolveGatedValue(_v, req) {
        calls.push(req);
        return behavior(req);
      },
    },
  };
}

/** Authorizes both gated slots with real bytes. */
function authorizingResolver(): MockResolver {
  return makeResolver((req) => {
    const value = req.slotId === "channel-name" ? CHANNEL_NAME : MESSAGE_BODY;
    return { state: "visible", value, versions: VERSIONS };
  });
}

/** Denies every gated slot — withholds with a synthetic placeholder. */
function denyingResolver(): MockResolver {
  return makeResolver(() => ({
    state: "withheld",
    placeholderShape: { mode: "synthetic" },
    versions: VERSIONS,
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unwrap(
  result: Awaited<ReturnType<typeof projectCanonicalRenderFrame>>,
): CoViewProjectedNode {
  if (!result.ok) throw new Error(`expected ok projection, got ${result.reason}: ${result.issues.join(", ")}`);
  return result.frame.root;
}

/** Structure with all `value` payloads removed, to compare shape across viewers. */
function stripValues(node: CoViewProjectedNode): unknown {
  const { value: _value, children, ...rest } = node;
  return {
    ...rest,
    ...(children !== undefined ? { children: children.map(stripValues) } : {}),
  };
}

function findNode(node: CoViewProjectedNode, id: string): CoViewProjectedNode | null {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Two-viewer parity: same structure, only values differ
// ---------------------------------------------------------------------------

describe("projectCanonicalRenderFrame — structure parity", () => {
  test("same canonical frame projects to two viewers with IDENTICAL structure, only values differ", async () => {
    const frame = buildPanelFrame();
    const auth = await projectCanonicalRenderFrame(frame, REGISTRY, viewer("billy"), authorizingResolver().resolver);
    const deny = await projectCanonicalRenderFrame(frame, REGISTRY, viewer("sarah"), denyingResolver().resolver);

    const billy = unwrap(auth);
    const sarah = unwrap(deny);

    // Structure (ids/kinds/boxes/state/attrs/children order) is byte-identical.
    expect(stripValues(sarah)).toEqual(stripValues(billy));

    // The message body differs: real for Billy, withheld for Sarah.
    expect(findNode(billy, "msg-text")?.value).toEqual({ state: "visible", value: MESSAGE_BODY });
    expect(findNode(sarah, "msg-text")?.value).toEqual({
      state: "withheld",
      placeholderShape: { mode: "synthetic" },
    });
  });

  test("controls / buttons / context-menu items remain present for the UNAUTHORIZED viewer", async () => {
    const frame = buildPanelFrame();
    const sarah = unwrap(
      await projectCanonicalRenderFrame(frame, REGISTRY, viewer("sarah"), denyingResolver().resolver),
    );

    // The whole context menu and its controls mirror — host UI, not viewer perms.
    const menu = findNode(sarah, "menu");
    expect(menu?.state).toEqual({ open: true });

    const del = findNode(sarah, "btn-delete");
    expect(del).not.toBeNull();
    expect(del?.kind).toBe("control");
    expect(del?.attrs?.controlKind).toBe("menuitem");
    expect(del?.state).toEqual({ hovered: true });
    // A control carries no value — present and unchanged, never projected away.
    expect(del && "value" in del).toBe(false);

    expect(findNode(sarah, "btn-markread")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Value projection paths
// ---------------------------------------------------------------------------

describe("projectCanonicalRenderFrame — value paths", () => {
  test("public unregistered content mirrors by default", async () => {
    const frame = buildPanelFrame();
    const billy = unwrap(
      await projectCanonicalRenderFrame(frame, REGISTRY, viewer("billy"), authorizingResolver().resolver),
    );
    expect(findNode(billy, "msg-author")?.value).toEqual({ state: "visible", value: "John" });
  });

  test("gated authorized calls the resolver and returns the real value", async () => {
    const frame = buildPanelFrame();
    const r = authorizingResolver();
    const billy = unwrap(await projectCanonicalRenderFrame(frame, REGISTRY, viewer("billy"), r.resolver));

    expect(findNode(billy, "channel-name")?.value).toEqual({ state: "visible", value: CHANNEL_NAME });
    expect(findNode(billy, "msg-text")?.value).toEqual({ state: "visible", value: MESSAGE_BODY });

    // Both gated slots were resolved through the injected authority.
    const resolvedSlots = r.calls.map((c) => c.slotId).sort();
    expect(resolvedSlots).toEqual(["channel-name", "msg-text"]);
    // The resolver received the registered policy/resource claim, not a host value.
    const msg = r.calls.find((c) => c.slotId === "msg-text");
    expect(msg?.policyRef).toBe("channel.message.read");
    expect(msg?.resourceRef).toEqual({ kind: "message", channelId: "c1", messageId: "m1" });
  });

  test("gated unauthorized returns a placeholder and the protected bytes are ABSENT from the wire", async () => {
    const frame = buildPanelFrame();
    const sarah = unwrap(
      await projectCanonicalRenderFrame(frame, REGISTRY, viewer("sarah"), denyingResolver().resolver),
    );

    expect(findNode(sarah, "channel-name")?.value).toEqual({
      state: "withheld",
      placeholderShape: { mode: "synthetic" },
    });

    // No protected substring crosses the unauthorized wire (foundation-plan §5.4).
    const serialized = JSON.stringify(sarah);
    expect(serialized).not.toContain(CHANNEL_NAME);
    expect(serialized).not.toContain(MESSAGE_BODY);
    expect(serialized).not.toContain("pricing");
  });

  test("secret NEVER calls the resolver and carries no value", async () => {
    const frame = buildPanelFrame();
    const r = authorizingResolver();
    const billy = unwrap(await projectCanonicalRenderFrame(frame, REGISTRY, viewer("billy"), r.resolver));

    const token = findNode(billy, "secret-token");
    expect(token?.value).toEqual({ state: "secret", placeholderShape: { mode: "absent" } });
    // The secret-state arm carries no `value` field at all.
    expect(token?.value && "value" in token.value).toBe(false);

    // The resolver/gate was never consulted for the secret slot — even though
    // this viewer is authorized for the gated slots.
    expect(r.calls.some((c) => c.slotId === "secret-token")).toBe(false);

    // And the secret bytes never appear anywhere on the wire.
    expect(JSON.stringify(billy)).not.toContain(SECRET_BYTES);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed / rejection paths
// ---------------------------------------------------------------------------

describe("projectCanonicalRenderFrame — fail closed", () => {
  test("a frame carrying origin:'local' is rejected by the schema (local cannot reach projection)", async () => {
    const frame = buildPanelFrame();
    // `local` is unrepresentable on the canonical wire type; force it past the
    // type system to prove the schema, not the type, is the runtime guard.
    (frame.root.children![0]!.children![1]! as { value: unknown }).value = { origin: "local" };

    const r = makeResolver(() => ({ state: "visible", value: "x", versions: VERSIONS }));
    const result = await projectCanonicalRenderFrame(frame, REGISTRY, viewer("billy"), r.resolver);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-frame");
    // Nothing was resolved — the whole frame was refused before any walk.
    expect(r.calls).toEqual([]);
  });

  test("a registered protected slot cannot be WIDENED to public — fails closed", async () => {
    const frame = buildPanelFrame();
    // Replace the gated channel-name value with a public one (a producer trying
    // to widen a gated slot). Must withhold, not mirror.
    (frame.root.children![0]!.children![1]! as { value: unknown }).value = {
      origin: "public",
      value: CHANNEL_NAME,
    };

    const r = authorizingResolver();
    const billy = unwrap(await projectCanonicalRenderFrame(frame, REGISTRY, viewer("billy"), r.resolver));

    expect(findNode(billy, "channel-name")?.value).toEqual({
      state: "withheld",
      placeholderShape: { mode: "synthetic" },
    });
    expect(JSON.stringify(billy)).not.toContain(CHANNEL_NAME);
    // A widened public value is never resolved through the gate.
    expect(r.calls.some((c) => c.slotId === "channel-name")).toBe(false);
  });

  test("a gated value whose policyRef MISMATCHES the registered slot fails closed before the resolver", async () => {
    const frame = buildPanelFrame();
    // msg-text slot is registered as channel.message.read; claim channel.read.
    (frame.root.children![1]!.children![1]! as { value: unknown }).value = {
      origin: "gated",
      policyRef: "channel.read",
      resourceRef: { kind: "message", channelId: "c1", messageId: "m1" },
      placeholderShape: { mode: "synthetic" },
    };

    const r = authorizingResolver();
    const billy = unwrap(await projectCanonicalRenderFrame(frame, REGISTRY, viewer("billy"), r.resolver));

    expect(findNode(billy, "msg-text")?.value).toEqual({
      state: "withheld",
      placeholderShape: { mode: "synthetic" },
    });
    // Validation failed → the resolver is never asked for this slot.
    expect(r.calls.some((c) => c.slotId === "msg-text")).toBe(false);
  });

  test("a gated value whose placeholder mode the slot REFUSES withholds with synthetic — the rejected shape never leaks", async () => {
    const frame = buildPanelFrame();
    // msg-text accepts only `synthetic`; the producer sends `preserve-host-rect`,
    // which would leak the host's real size/existence. validateCanonicalSlotValue
    // rejects it (placeholder-mode-not-accepted) and projection must NOT echo it.
    (frame.root.children![1]!.children![1]! as { value: unknown }).value = {
      origin: "gated",
      policyRef: "channel.message.read",
      resourceRef: { kind: "message", channelId: "c1", messageId: "m1" },
      placeholderShape: { mode: "preserve-host-rect", sizeLeakAccepted: true, reason: "leak attempt" },
    };

    const r = authorizingResolver();
    const billy = unwrap(await projectCanonicalRenderFrame(frame, REGISTRY, viewer("billy"), r.resolver));

    expect(findNode(billy, "msg-text")?.value).toEqual({
      state: "withheld",
      placeholderShape: { mode: "synthetic" },
    });
    // Validation failed → the resolver is never asked for this slot.
    expect(r.calls.some((c) => c.slotId === "msg-text")).toBe(false);
    // The refused preserve-host-rect shape does not survive into the projection.
    expect(JSON.stringify(billy)).not.toContain("preserve-host-rect");
  });

  test("malformed: unknown node kind rejects the WHOLE frame", async () => {
    const frame = buildPanelFrame();
    (frame.root.children![2]!.children![0]! as { kind: string }).kind = "script";

    const r = authorizingResolver();
    const result = await projectCanonicalRenderFrame(frame, REGISTRY, viewer("billy"), r.resolver);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-frame");
    expect(r.calls).toEqual([]);
  });

  test("malformed: a value-bearing secret rejects the WHOLE frame", async () => {
    const frame = buildPanelFrame();
    // A secret arm may not carry a value — the strict schema rejects the stray key.
    (frame.root.children![1]!.children![2]! as { value: unknown }).value = {
      origin: "secret",
      placeholderShape: { mode: "absent" },
      value: SECRET_BYTES,
    };

    const result = await projectCanonicalRenderFrame(frame, REGISTRY, viewer("billy"), authorizingResolver().resolver);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-frame");
  });

  test("malformed: an unsafe attribute rejects the WHOLE frame", async () => {
    const frame = buildPanelFrame();
    // `href` is data-bearing and not on the safe-attrs allowlist.
    (frame.root.children![2]!.children![0]! as { attrs: unknown }).attrs = { href: "https://evil.example" };

    const result = await projectCanonicalRenderFrame(frame, REGISTRY, viewer("billy"), authorizingResolver().resolver);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-frame");
  });

  test("resolver 'unsupported' passes through as an unsupported projected value", async () => {
    const frame = buildPanelFrame();
    const r = makeResolver(() => ({ state: "unsupported", reason: "unknown-resource-type" }));
    const billy = unwrap(await projectCanonicalRenderFrame(frame, REGISTRY, viewer("billy"), r.resolver));
    expect(findNode(billy, "msg-text")?.value).toEqual({ state: "unsupported", reason: "unknown-resource-type" });
  });

  test("resolver throw fails closed to withheld without rejecting the projection", async () => {
    const frame = buildPanelFrame();
    const r = makeResolver(() => {
      throw new Error("adapter unavailable");
    });

    const billy = unwrap(await projectCanonicalRenderFrame(frame, REGISTRY, viewer("billy"), r.resolver));

    expect(findNode(billy, "msg-text")?.value).toEqual({
      state: "withheld",
      placeholderShape: { mode: "synthetic" },
    });
    expect(r.calls.some((c) => c.slotId === "msg-text")).toBe(true);
  });
});
