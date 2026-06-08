// Type-level + runtime contract tests for the CoView render-tree types
// (CV-FOUND-1). The `@ts-expect-error` assertions are validated by
// `bun run typecheck` (an unused directive is itself a type error); the runtime
// `expect`s give `bun test packages/protocol` something to execute.
//
// These prove the structural security guarantees that the schema package cannot
// (a wire-rejection can be bypassed by a buggy caller; a type the caller can't
// even construct cannot):
//   - a canonical value ref has no `local` arm;
//   - a canonical `secret` ref cannot carry a value;
//   - a projected viewer value cannot carry a secret/local value, and `secret`
//     is never the value-bearing `visible` arm;
//   - the same node structure can carry either a canonical or a projected value.

import { describe, test, expect } from "bun:test";
import {
  CO_VIEW_VALUE_ORIGINS,
  CO_VIEW_NODE_KINDS,
  CO_VIEW_CONTROL_KINDS,
  CO_VIEW_POLICY_REFS,
} from "./co-view-render-tree.js";
import type {
  CoViewCanonicalValueRef,
  CoViewValueRef,
  CoViewProjectedValue,
  CoViewRenderNode,
  CoViewProjectedNode,
} from "./co-view-render-tree.js";

// ---------------------------------------------------------------------------
// Local origin is unrepresentable on the canonical wire type
// ---------------------------------------------------------------------------

// The producer-internal type DOES include `local` (a producer may hold it
// before its serializer drops it).
const producerLocal: CoViewValueRef = { origin: "local" };
void producerLocal;

// The canonical *wire* type does NOT — `{ origin: "local" }` is unassignable.
// @ts-expect-error — `local` is excluded from the canonical wire value ref
const canonicalLocal: CoViewCanonicalValueRef = { origin: "local" };
void canonicalLocal;

// ---------------------------------------------------------------------------
// Secret carries no value (canonical) and never becomes visible (projected)
// ---------------------------------------------------------------------------

const canonicalSecret: CoViewCanonicalValueRef = {
  origin: "secret",
  placeholderShape: { mode: "absent" },
};
void canonicalSecret;

// prettier-ignore
// @ts-expect-error — a canonical secret ref has no `value` field
const secretWithValue: CoViewCanonicalValueRef = { origin: "secret", placeholderShape: { mode: "absent" }, value: "super-secret" };
void secretWithValue;

// prettier-ignore
// @ts-expect-error — a canonical secret placeholder cannot be preserve-host-rect
const secretRect: CoViewCanonicalValueRef = { origin: "secret", placeholderShape: { mode: "preserve-host-rect", sizeLeakAccepted: true, reason: "x" } };
void secretRect;

const projectedSecret: CoViewProjectedValue = {
  state: "secret",
  placeholderShape: { mode: "absent" },
};
void projectedSecret;

// prettier-ignore
// @ts-expect-error — a projected `secret` value cannot carry a value to a viewer
const projectedSecretValue: CoViewProjectedValue = { state: "secret", placeholderShape: { mode: "absent" }, value: "leaked" };
void projectedSecretValue;

// The only value-bearing projected arm is `visible`, and it carries no origin
// marker — there is no "visible secret" representation.
const projectedVisible: CoViewProjectedValue = { state: "visible", value: "leadership" };
void projectedVisible;

// ---------------------------------------------------------------------------
// Same structure, different value type (canonical vs projected)
// ---------------------------------------------------------------------------

const canonicalNode: CoViewRenderNode = {
  id: "channel-name",
  kind: "text",
  box: { x: 0, y: 0, width: 120, height: 20 },
  value: {
    origin: "gated",
    policyRef: "channel.read",
    resourceRef: { kind: "channel", channelId: "leadership" },
    placeholderShape: { mode: "synthetic" },
  },
};
void canonicalNode;

const projectedNode: CoViewProjectedNode = {
  id: "channel-name",
  kind: "text",
  box: { x: 0, y: 0, width: 120, height: 20 },
  value: { state: "withheld", placeholderShape: { mode: "synthetic" } },
};
void projectedNode;

// A control node carries no value in either tree — its existence is structure.
const controlNode: CoViewRenderNode = {
  id: "delete-channel",
  kind: "control",
  box: { x: 0, y: 0, width: 120, height: 28 },
  attrs: { controlKind: "button" },
};
void controlNode;

// prettier-ignore
// @ts-expect-error — a canonical node cannot carry a projected value
const mixedNode: CoViewRenderNode = { id: "x", kind: "text", box: { x: 0, y: 0, width: 1, height: 1 }, value: { state: "visible", value: "leadership" } };
void mixedNode;

// ---------------------------------------------------------------------------
// Runtime: frozen vocabularies are exported and complete
// ---------------------------------------------------------------------------

describe("CoView render-tree vocabularies", () => {
  test("value origins", () => {
    expect([...CO_VIEW_VALUE_ORIGINS]).toEqual(["public", "gated", "secret", "local"]);
  });
  test("node kinds are the six safe kinds", () => {
    expect([...CO_VIEW_NODE_KINDS]).toEqual(["element", "text", "image", "canvas", "icon", "control"]);
  });
  test("control kinds", () => {
    expect(CO_VIEW_CONTROL_KINDS).toContain("button");
    expect(CO_VIEW_CONTROL_KINDS).toContain("menuitem");
  });
  test("policy refs include channel + plugin resource reads", () => {
    expect(CO_VIEW_POLICY_REFS).toContain("channel.read");
    expect(CO_VIEW_POLICY_REFS).toContain("plugin.resource.read");
  });
});
