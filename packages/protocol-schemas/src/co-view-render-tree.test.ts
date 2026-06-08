import { describe, test, expect } from "bun:test";
import {
  CoViewValueOriginSchema,
  CoViewPolicyRefSchema,
  CoViewResourceRefSchema,
  CoViewNonRectPlaceholderShapeSchema,
  CoViewCanonicalValueRefSchema,
  CoViewNodeKindSchema,
  CoViewControlKindSchema,
  CoViewBoxSchema,
  CoViewNodeStateSchema,
  CoViewSafeAttrsSchema,
  CoViewRenderNodeSchema,
  CoViewCanonicalRenderFrameSchema,
  CoViewProjectedValueSchema,
  CoViewProjectedNodeSchema,
  CoViewProjectedRenderFrameSchema,
  CoViewSurfaceSlotSchemaSchema,
  CoViewSurfaceSchemaSchema,
  CoViewSurfaceRegistrySchema,
  validateCanonicalSlotValue,
} from "./co-view-render-tree";
import type {
  CoViewRenderNode,
  CoViewProjectedNode,
  CoViewSurfaceRegistry,
  CoViewCanonicalValueRef,
} from "@uncorded/protocol";

// ---------------------------------------------------------------------------
// Value origins / policy / resource refs
// ---------------------------------------------------------------------------

describe("CoViewValueOriginSchema", () => {
  test("accepts the four origins", () => {
    for (const o of ["public", "gated", "secret", "local"]) {
      expect(CoViewValueOriginSchema.safeParse(o).success).toBe(true);
    }
  });
  test("rejects unknown origin", () => {
    expect(CoViewValueOriginSchema.safeParse("leaked").success).toBe(false);
  });
});

describe("CoViewPolicyRefSchema", () => {
  test("accepts known policy refs", () => {
    for (const p of ["channel.read", "album.read", "plugin.resource.read"]) {
      expect(CoViewPolicyRefSchema.safeParse(p).success).toBe(true);
    }
  });
  test("rejects unknown policy ref", () => {
    expect(CoViewPolicyRefSchema.safeParse("channel.write").success).toBe(false);
  });
});

describe("CoViewResourceRefSchema", () => {
  test("accepts a channel ref", () => {
    expect(
      CoViewResourceRefSchema.safeParse({ kind: "channel", channelId: "c1" }).success,
    ).toBe(true);
  });
  test("accepts the pluginResource arm (shared with RP-FOUND-1)", () => {
    expect(
      CoViewResourceRefSchema.safeParse({
        kind: "pluginResource",
        pluginSlug: "family-album",
        resourceType: "album",
        resourceId: "summer-2026",
      }).success,
    ).toBe(true);
  });
  test("rejects unknown kind", () => {
    expect(CoViewResourceRefSchema.safeParse({ kind: "secret-store", id: "x" }).success).toBe(false);
  });
  test("rejects message ref missing messageId", () => {
    expect(CoViewResourceRefSchema.safeParse({ kind: "message", channelId: "c1" }).success).toBe(false);
  });
  test("rejects an arm carrying an extra key (strict — no smuggling)", () => {
    expect(
      CoViewResourceRefSchema.safeParse({ kind: "channel", channelId: "c1", secretToken: "x" }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Node primitives — kinds, control kinds, attrs allowlist
// ---------------------------------------------------------------------------

describe("CoViewNodeKindSchema", () => {
  test("accepts the six safe kinds", () => {
    for (const k of ["element", "text", "image", "canvas", "icon", "control"]) {
      expect(CoViewNodeKindSchema.safeParse(k).success).toBe(true);
    }
  });
  test("rejects unknown/unsafe node kinds", () => {
    for (const k of ["script", "iframe", "object", "embed", "style"]) {
      expect(CoViewNodeKindSchema.safeParse(k).success).toBe(false);
    }
  });
});

describe("CoViewControlKindSchema", () => {
  test("accepts allowlisted control kinds", () => {
    expect(CoViewControlKindSchema.safeParse("button").success).toBe(true);
    expect(CoViewControlKindSchema.safeParse("menuitem").success).toBe(true);
  });
  test("rejects unknown control kind", () => {
    expect(CoViewControlKindSchema.safeParse("hyperlink").success).toBe(false);
  });
});

describe("CoViewBoxSchema", () => {
  test("accepts a box; negative width rejects", () => {
    expect(CoViewBoxSchema.safeParse({ x: 0, y: 0, width: 10, height: 5 }).success).toBe(true);
    expect(CoViewBoxSchema.safeParse({ x: 0, y: 0, width: -1, height: 5 }).success).toBe(false);
  });
});

describe("CoViewNodeStateSchema", () => {
  test("accepts known interaction state", () => {
    expect(
      CoViewNodeStateSchema.safeParse({ hovered: true, open: true, scroll: { x: 0, y: 12 } }).success,
    ).toBe(true);
  });
  test("rejects an unknown state flag (strict)", () => {
    expect(CoViewNodeStateSchema.safeParse({ glowing: true }).success).toBe(false);
  });
});

describe("CoViewSafeAttrsSchema (allowlist)", () => {
  test("accepts allowlisted attrs", () => {
    expect(
      CoViewSafeAttrsSchema.safeParse({
        classTokens: ["danger", "is-hovered"],
        ariaRole: "menuitem",
        ariaExpanded: true,
        controlKind: "button",
      }).success,
    ).toBe(true);
  });

  test("rejects unsafe / data-bearing attributes", () => {
    for (const unsafe of [
      { href: "https://leak.example/secret" },
      { src: "photo://real/123" },
      { style: "background:url(x)" },
      { title: "private channel name" },
      { alt: "Kids at the pier" },
      { ariaLabel: "leadership" },
      { "data-channel": "leadership" },
    ]) {
      expect(CoViewSafeAttrsSchema.safeParse(unsafe).success).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Canonical value refs — local rejects, secret carries no value, gated shape
// ---------------------------------------------------------------------------

describe("CoViewNonRectPlaceholderShapeSchema", () => {
  test("synthetic + absent accepted; preserve-host-rect unrepresentable", () => {
    expect(CoViewNonRectPlaceholderShapeSchema.safeParse({ mode: "synthetic" }).success).toBe(true);
    expect(CoViewNonRectPlaceholderShapeSchema.safeParse({ mode: "absent" }).success).toBe(true);
    expect(
      CoViewNonRectPlaceholderShapeSchema.safeParse({
        mode: "preserve-host-rect",
        sizeLeakAccepted: true,
        reason: "x",
      }).success,
    ).toBe(false);
  });
});

describe("CoViewCanonicalValueRefSchema", () => {
  const channelRef = { kind: "channel", channelId: "c1" } as const;

  test("public value travels with its value", () => {
    expect(
      CoViewCanonicalValueRefSchema.safeParse({ origin: "public", value: "hello" }).success,
    ).toBe(true);
  });

  test("gated requires policyRef + resourceRef + placeholderShape", () => {
    // complete gated ref (runtime-resolved: no host value) is valid
    expect(
      CoViewCanonicalValueRefSchema.safeParse({
        origin: "gated",
        policyRef: "channel.read",
        resourceRef: channelRef,
        placeholderShape: { mode: "synthetic", lines: 1 },
      }).success,
    ).toBe(true);

    // missing policyRef rejects
    expect(
      CoViewCanonicalValueRefSchema.safeParse({
        origin: "gated",
        resourceRef: channelRef,
        placeholderShape: { mode: "synthetic" },
      }).success,
    ).toBe(false);

    // missing resourceRef rejects
    expect(
      CoViewCanonicalValueRefSchema.safeParse({
        origin: "gated",
        policyRef: "channel.read",
        placeholderShape: { mode: "synthetic" },
      }).success,
    ).toBe(false);

    // missing placeholderShape rejects
    expect(
      CoViewCanonicalValueRefSchema.safeParse({
        origin: "gated",
        policyRef: "channel.read",
        resourceRef: channelRef,
      }).success,
    ).toBe(false);
  });

  test("incoming canonical frame with origin: \"local\" rejects deterministically", () => {
    expect(CoViewCanonicalValueRefSchema.safeParse({ origin: "local" }).success).toBe(false);
    // even with stray fields, there is no `local` arm to match
    expect(
      CoViewCanonicalValueRefSchema.safeParse({ origin: "local", value: "x" }).success,
    ).toBe(false);
  });

  test("secret carries NO value — a value-bearing secret rejects (not stripped)", () => {
    // valid secret: placeholder only
    expect(
      CoViewCanonicalValueRefSchema.safeParse({
        origin: "secret",
        placeholderShape: { mode: "absent" },
      }).success,
    ).toBe(true);
    // secret carrying a value is rejected whole
    expect(
      CoViewCanonicalValueRefSchema.safeParse({
        origin: "secret",
        placeholderShape: { mode: "absent" },
        value: "super-secret-token",
      }).success,
    ).toBe(false);
    // secret cannot use preserve-host-rect (would leak size/existence)
    expect(
      CoViewCanonicalValueRefSchema.safeParse({
        origin: "secret",
        placeholderShape: { mode: "preserve-host-rect", sizeLeakAccepted: true, reason: "x" },
      }).success,
    ).toBe(false);
  });

  test("preserve-host-rect with empty/missing reason rejects (gated placeholder)", () => {
    const base = {
      origin: "gated" as const,
      policyRef: "channel.read" as const,
      resourceRef: channelRef,
    };
    // valid preserve-host-rect
    expect(
      CoViewCanonicalValueRefSchema.safeParse({
        ...base,
        placeholderShape: { mode: "preserve-host-rect", sizeLeakAccepted: true, reason: "layout parity" },
      }).success,
    ).toBe(true);
    // empty reason rejects
    expect(
      CoViewCanonicalValueRefSchema.safeParse({
        ...base,
        placeholderShape: { mode: "preserve-host-rect", sizeLeakAccepted: true, reason: "" },
      }).success,
    ).toBe(false);
    // missing sizeLeakAccepted rejects (cannot opt into leak by omission)
    expect(
      CoViewCanonicalValueRefSchema.safeParse({
        ...base,
        placeholderShape: { mode: "preserve-host-rect", reason: "x" },
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Projected value — secret-safe by construction
// ---------------------------------------------------------------------------

describe("CoViewProjectedValueSchema", () => {
  test("visible / withheld / secret / unsupported", () => {
    expect(CoViewProjectedValueSchema.safeParse({ state: "visible", value: "leadership" }).success).toBe(true);
    expect(
      CoViewProjectedValueSchema.safeParse({ state: "withheld", placeholderShape: { mode: "synthetic" } }).success,
    ).toBe(true);
    expect(
      CoViewProjectedValueSchema.safeParse({ state: "secret", placeholderShape: { mode: "absent" } }).success,
    ).toBe(true);
    expect(CoViewProjectedValueSchema.safeParse({ state: "unsupported", reason: "no adapter" }).success).toBe(true);
  });

  test("secret cannot carry a value and cannot appear as visible", () => {
    // a projected secret state has no value field — a value-bearing secret rejects
    expect(
      CoViewProjectedValueSchema.safeParse({ state: "secret", value: "token", placeholderShape: { mode: "absent" } })
        .success,
    ).toBe(false);
    // there is no `state: "secret"` path that yields a value to a viewer; the
    // only value-bearing state is `visible`, which carries no origin marker.
    const secretProjected = CoViewProjectedValueSchema.parse({ state: "secret", placeholderShape: { mode: "absent" } });
    expect("value" in secretProjected).toBe(false);
  });

  test("visible without a value rejects", () => {
    expect(CoViewProjectedValueSchema.safeParse({ state: "visible" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Render nodes & frames — structure parity, control independence
// ---------------------------------------------------------------------------

// A host-rendered channel panel: a gated channel-name text node and a
// host-permission-derived "Delete channel" control button with hover state.
const buildCanonicalPanel = (): CoViewRenderNode => ({
  id: "p1",
  kind: "element",
  box: { x: 0, y: 0, width: 320, height: 240 },
  attrs: { classTokens: ["channel-panel"] },
  children: [
    {
      id: "channel-name",
      kind: "text",
      box: { x: 8, y: 8, width: 120, height: 20 },
      value: {
        origin: "gated",
        policyRef: "channel.read",
        resourceRef: { kind: "channel", channelId: "leadership" },
        placeholderShape: { mode: "synthetic", width: 120 },
      },
    },
    {
      id: "delete-channel",
      kind: "control",
      box: { x: 8, y: 200, width: 120, height: 28 },
      state: { hovered: true },
      attrs: { controlKind: "button", classTokens: ["danger", "is-hovered"] },
    },
  ],
});

describe("CoViewRenderNodeSchema / canonical frame", () => {
  test("a nested host render tree parses", () => {
    expect(
      CoViewCanonicalRenderFrameSchema.safeParse({ surfaceId: "text-channel", root: buildCanonicalPanel() }).success,
    ).toBe(true);
  });

  test("a node carrying an unsafe attribute rejects (strict node)", () => {
    const bad = buildCanonicalPanel();
    // smuggle a raw href onto the panel node itself
    (bad as unknown as Record<string, unknown>)["href"] = "https://leak.example";
    expect(CoViewRenderNodeSchema.safeParse(bad).success).toBe(false);
  });

  test("an unknown node kind anywhere in the tree rejects", () => {
    const bad = buildCanonicalPanel();
    bad.children![1]!.kind = "iframe" as never;
    expect(CoViewRenderNodeSchema.safeParse(bad).success).toBe(false);
  });

  test("a canonical frame carrying an extra top-level key rejects (strict frame)", () => {
    expect(
      CoViewCanonicalRenderFrameSchema.safeParse({
        surfaceId: "text-channel",
        root: buildCanonicalPanel(),
        viewerId: "smuggled",
      }).success,
    ).toBe(false);
  });
});

describe("structure parity vs per-viewer value projection", () => {
  // Same structure (ids/kinds/controls), different projected values per viewer.
  const projectedFor = (channelNameValue: CoViewProjectedNode["value"]): CoViewProjectedNode => ({
    id: "p1",
    kind: "element",
    box: { x: 0, y: 0, width: 320, height: 240 },
    attrs: { classTokens: ["channel-panel"] },
    children: [
      {
        id: "channel-name",
        kind: "text",
        box: { x: 8, y: 8, width: 120, height: 20 },
        value: channelNameValue,
      },
      {
        id: "delete-channel",
        kind: "control",
        box: { x: 8, y: 200, width: 120, height: 28 },
        state: { hovered: true },
        attrs: { controlKind: "button", classTokens: ["danger", "is-hovered"] },
      },
    ],
  });

  const authorized = projectedFor({ state: "visible", value: "leadership" });
  const unauthorized = projectedFor({ state: "withheld", placeholderShape: { mode: "synthetic", width: 120 } });

  test("the SAME structure can carry projected value differences", () => {
    expect(CoViewProjectedNodeSchema.safeParse(authorized).success).toBe(true);
    expect(CoViewProjectedNodeSchema.safeParse(unauthorized).success).toBe(true);

    // identity & structure are identical across viewers; only the value differs
    const ids = (n: CoViewProjectedNode): string[] => [n.id, ...(n.children ?? []).flatMap(ids)];
    const kinds = (n: CoViewProjectedNode): string[] => [n.kind, ...(n.children ?? []).flatMap(kinds)];
    expect(ids(authorized)).toEqual(ids(unauthorized));
    expect(kinds(authorized)).toEqual(kinds(unauthorized));

    const authName = authorized.children![0]!.value;
    const unauthName = unauthorized.children![0]!.value;
    expect(authName).toEqual({ state: "visible", value: "leadership" });
    expect(unauthName).toEqual({ state: "withheld", placeholderShape: { mode: "synthetic", width: 120 } });
  });

  test("buttons/controls are representable independent of viewer permission", () => {
    // the control node is identical for both viewers and carries NO value —
    // its existence is host UI structure, not a viewer entitlement.
    const authBtn = authorized.children![1]!;
    const unauthBtn = unauthorized.children![1]!;
    expect(authBtn).toEqual(unauthBtn);
    expect(authBtn.value).toBeUndefined();
    expect(authBtn.attrs?.controlKind).toBe("button");
    expect(CoViewProjectedRenderFrameSchema.safeParse({ surfaceId: "text-channel", root: authorized }).success).toBe(
      true,
    );
    expect(CoViewProjectedRenderFrameSchema.safeParse({ surfaceId: "text-channel", root: unauthorized }).success).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Surface schema registry & fail-closed validation
// ---------------------------------------------------------------------------

describe("CoViewSurfaceSlotSchemaSchema", () => {
  test("a gated slot must declare policyRef + resourceRefRequired: true", () => {
    // valid gated slot
    expect(
      CoViewSurfaceSlotSchemaSchema.safeParse({
        slotId: "channel-name",
        origin: "gated",
        policyRef: "channel.read",
        resourceRefRequired: true,
        placeholderModes: ["synthetic"],
      }).success,
    ).toBe(true);
    // gated slot missing policyRef rejects
    expect(
      CoViewSurfaceSlotSchemaSchema.safeParse({
        slotId: "channel-name",
        origin: "gated",
        resourceRefRequired: true,
        placeholderModes: ["synthetic"],
      }).success,
    ).toBe(false);
    // gated slot without resourceRefRequired:true rejects
    expect(
      CoViewSurfaceSlotSchemaSchema.safeParse({
        slotId: "channel-name",
        origin: "gated",
        policyRef: "channel.read",
        placeholderModes: ["synthetic"],
      }).success,
    ).toBe(false);
  });

  test("a public slot needs no policy", () => {
    expect(
      CoViewSurfaceSlotSchemaSchema.safeParse({
        slotId: "label",
        origin: "public",
        placeholderModes: [],
      }).success,
    ).toBe(true);
  });
});

describe("CoViewSurfaceSchemaSchema / registry", () => {
  test("duplicate slot ids reject", () => {
    expect(
      CoViewSurfaceSchemaSchema.safeParse({
        surfaceId: "text-channel",
        slots: [
          { slotId: "name", origin: "public", placeholderModes: [] },
          { slotId: "name", origin: "public", placeholderModes: [] },
        ],
      }).success,
    ).toBe(false);
  });

  test("a full registry parses", () => {
    expect(CoViewSurfaceRegistrySchema.safeParse(REGISTRY).success).toBe(true);
  });

  test("a slot carrying an extra key rejects (strict slot)", () => {
    expect(
      CoViewSurfaceSlotSchemaSchema.safeParse({
        slotId: "label",
        origin: "public",
        placeholderModes: [],
        producerValueAllowedTypo: true,
      }).success,
    ).toBe(false);
  });

  test("a registry carrying an extra top-level key rejects (strict registry)", () => {
    expect(
      CoViewSurfaceRegistrySchema.safeParse({ surfaces: {}, version: 2 }).success,
    ).toBe(false);
  });

  test("a registry whose map key disagrees with the inner surfaceId rejects", () => {
    expect(
      CoViewSurfaceRegistrySchema.safeParse({
        surfaces: {
          "text-channel": { surfaceId: "voice-channel", slots: [] },
        },
      }).success,
    ).toBe(false);
  });
});

const REGISTRY: CoViewSurfaceRegistry = {
  surfaces: {
    "text-channel": {
      surfaceId: "text-channel",
      slots: [
        {
          slotId: "channel-name",
          origin: "gated",
          policyRef: "channel.read",
          resourceRefRequired: true,
          placeholderModes: ["synthetic"],
          // producerValueAllowed omitted → defaults to false (fail closed)
        },
        {
          slotId: "host-provided-name",
          origin: "gated",
          policyRef: "channel.read",
          resourceRefRequired: true,
          placeholderModes: ["synthetic"],
          producerValueAllowed: true,
        },
        {
          slotId: "secret-token",
          origin: "secret",
          placeholderModes: ["absent"],
        },
      ],
    },
  },
};

describe("validateCanonicalSlotValue (fail-closed)", () => {
  const gatedRuntimeResolved: CoViewCanonicalValueRef = {
    origin: "gated",
    policyRef: "channel.read",
    resourceRef: { kind: "channel", channelId: "leadership" },
    placeholderShape: { mode: "synthetic" },
  };

  test("a PROTECTED claim (gated/secret) on an unknown surface / slot rejects", () => {
    // protected provenance requires a registered slot, so it fails closed
    expect(validateCanonicalSlotValue(REGISTRY, "nope", "channel-name", gatedRuntimeResolved)).toEqual({
      ok: false,
      reason: "unknown-surface",
    });
    expect(validateCanonicalSlotValue(REGISTRY, "text-channel", "nope", gatedRuntimeResolved)).toEqual({
      ok: false,
      reason: "unknown-slot",
    });
  });

  test("ordinary public/unmarked content mirrors by default — never withheld for lack of registration", () => {
    // This is the mirror-by-default contract: unmarked plugin output is ordinary
    // UI, not magically private. A public value on an unregistered surface OR an
    // unregistered slot is accepted, NOT `unknown-surface`/`unknown-slot`.
    const publicValue: CoViewCanonicalValueRef = { origin: "public", value: "Channel settings" };
    expect(validateCanonicalSlotValue(REGISTRY, "nope", "anything", publicValue)).toEqual({ ok: true });
    expect(validateCanonicalSlotValue(REGISTRY, "text-channel", "not-a-slot", publicValue)).toEqual({ ok: true });
    // The ONLY constraint on a public value: it may not occupy a registered
    // protected slot (that would widen gated/secret → public).
    expect(validateCanonicalSlotValue(REGISTRY, "text-channel", "channel-name", publicValue)).toEqual({
      ok: false,
      reason: "origin-widened",
    });
  });

  test("runtime-resolved gated value (no host value) is accepted on a default slot", () => {
    expect(validateCanonicalSlotValue(REGISTRY, "text-channel", "channel-name", gatedRuntimeResolved)).toEqual({
      ok: true,
    });
  });

  test("producerValueAllowed omission is fail-closed: a host-provided value rejects", () => {
    const hostProvided: CoViewCanonicalValueRef = { ...gatedRuntimeResolved, value: "leadership" };
    // channel-name omits producerValueAllowed → treated as false → reject
    expect(validateCanonicalSlotValue(REGISTRY, "text-channel", "channel-name", hostProvided)).toEqual({
      ok: false,
      reason: "producer-value-not-allowed",
    });
    // host-provided-name opts in → accepted
    expect(validateCanonicalSlotValue(REGISTRY, "text-channel", "host-provided-name", hostProvided)).toEqual({
      ok: true,
    });
  });

  test("a producer cannot widen a registered gated slot to public", () => {
    const publicValue: CoViewCanonicalValueRef = { origin: "public", value: "leadership" };
    expect(validateCanonicalSlotValue(REGISTRY, "text-channel", "channel-name", publicValue)).toEqual({
      ok: false,
      reason: "origin-widened",
    });
  });

  test("a producer cannot widen a registered secret slot to public or gated", () => {
    const publicValue: CoViewCanonicalValueRef = { origin: "public", value: "token" };
    expect(validateCanonicalSlotValue(REGISTRY, "text-channel", "secret-token", publicValue)).toEqual({
      ok: false,
      reason: "origin-widened",
    });
    expect(validateCanonicalSlotValue(REGISTRY, "text-channel", "secret-token", gatedRuntimeResolved)).toEqual({
      ok: false,
      reason: "origin-widened",
    });
  });

  test("a gated value whose policyRef differs from the slot's registered policy rejects", () => {
    // channel-name is registered against "channel.read"; a value evaluated
    // against "member.read" must not be accepted on it.
    const wrongPolicy: CoViewCanonicalValueRef = {
      origin: "gated",
      policyRef: "member.read",
      resourceRef: { kind: "member", userId: "u1" },
      placeholderShape: { mode: "synthetic" },
    };
    expect(validateCanonicalSlotValue(REGISTRY, "text-channel", "channel-name", wrongPolicy)).toEqual({
      ok: false,
      reason: "policy-ref-mismatch",
    });
    // matching policy on the same slot is accepted
    expect(validateCanonicalSlotValue(REGISTRY, "text-channel", "channel-name", gatedRuntimeResolved)).toEqual({
      ok: true,
    });
  });

  test("an unaccepted placeholder mode rejects", () => {
    const rectPlaceholder: CoViewCanonicalValueRef = {
      origin: "gated",
      policyRef: "channel.read",
      resourceRef: { kind: "channel", channelId: "leadership" },
      placeholderShape: { mode: "preserve-host-rect", sizeLeakAccepted: true, reason: "parity" },
    };
    // channel-name accepts only "synthetic"
    expect(validateCanonicalSlotValue(REGISTRY, "text-channel", "channel-name", rectPlaceholder)).toEqual({
      ok: false,
      reason: "placeholder-mode-not-accepted",
    });
  });

  test("a secret value is accepted on the secret slot", () => {
    const secretValue: CoViewCanonicalValueRef = { origin: "secret", placeholderShape: { mode: "absent" } };
    expect(validateCanonicalSlotValue(REGISTRY, "text-channel", "secret-token", secretValue)).toEqual({ ok: true });
  });
});
