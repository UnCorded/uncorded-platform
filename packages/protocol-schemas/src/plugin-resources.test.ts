import { describe, test, expect } from "bun:test";
import {
  PluginResourceKeySchema,
  PluginResourceRefSchema,
  BasePluginResourceActionSchema,
  PluginResourceActionSchema,
  PlaceholderShapeSchema,
  ValueSlotRefSchema,
  AuthVersionsSchema,
  AuthDecisionSchema,
  EffectiveAclDecisionSchema,
  ResolvedPluginResourceValueSchema,
  ViewerContextSchema,
  ValueSlotDefinitionSchema,
  PluginResourceTypeRegistrationSchema,
  ResourcePrincipalSchema,
  ResourceAclEntrySchema,
} from "./plugin-resources";

// ---------------------------------------------------------------------------
// Resource identity
// ---------------------------------------------------------------------------

describe("PluginResourceKeySchema", () => {
  const valid = {
    serverId: "srv-1",
    pluginSlug: "family-album",
    resourceType: "album",
    resourceId: "summer-2026",
  };

  test("valid key", () => {
    expect(PluginResourceKeySchema.safeParse(valid).success).toBe(true);
  });

  test("missing serverId rejects", () => {
    const { serverId: _omit, ...rest } = valid;
    expect(PluginResourceKeySchema.safeParse(rest).success).toBe(false);
  });

  test("empty resourceId rejects", () => {
    expect(
      PluginResourceKeySchema.safeParse({ ...valid, resourceId: "" }).success,
    ).toBe(false);
  });

  test("non-string field rejects", () => {
    expect(
      PluginResourceKeySchema.safeParse({ ...valid, resourceType: 7 }).success,
    ).toBe(false);
  });
});

describe("PluginResourceRefSchema", () => {
  test("valid pluginResource ref", () => {
    expect(
      PluginResourceRefSchema.safeParse({
        kind: "pluginResource",
        pluginSlug: "family-album",
        resourceType: "photo",
        resourceId: "img-001",
      }).success,
    ).toBe(true);
  });

  test("wrong kind rejects (ref carries no serverId, only plugin identity)", () => {
    expect(
      PluginResourceRefSchema.safeParse({
        kind: "channel",
        pluginSlug: "family-album",
        resourceType: "photo",
        resourceId: "img-001",
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Action vocabulary — base + namespaced custom; bare unknown fails closed
// ---------------------------------------------------------------------------

describe("action vocabulary", () => {
  test("all base actions valid", () => {
    for (const a of ["read", "comment", "edit", "share", "admin"]) {
      expect(BasePluginResourceActionSchema.safeParse(a).success).toBe(true);
      expect(PluginResourceActionSchema.safeParse(a).success).toBe(true);
    }
  });

  test("namespaced custom action valid", () => {
    expect(
      PluginResourceActionSchema.safeParse("family-album:download").success,
    ).toBe(true);
  });

  test("bare unknown verb fails closed", () => {
    // not a base verb and not namespaced — rejected, never silently accepted
    expect(PluginResourceActionSchema.safeParse("delete").success).toBe(false);
    expect(BasePluginResourceActionSchema.safeParse("delete").success).toBe(false);
  });

  test("custom action without namespace rejects", () => {
    expect(PluginResourceActionSchema.safeParse("download").success).toBe(false);
  });

  test("malformed namespace (double colon / empty segment) rejects", () => {
    expect(PluginResourceActionSchema.safeParse("a::b").success).toBe(false);
    expect(PluginResourceActionSchema.safeParse(":download").success).toBe(false);
    expect(PluginResourceActionSchema.safeParse("family-album:").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Placeholders & value slots
// ---------------------------------------------------------------------------

describe("PlaceholderShapeSchema", () => {
  test("synthetic with and without hints", () => {
    expect(PlaceholderShapeSchema.safeParse({ mode: "synthetic" }).success).toBe(true);
    expect(
      PlaceholderShapeSchema.safeParse({ mode: "synthetic", lines: 12 }).success,
    ).toBe(true);
  });

  test("absent", () => {
    expect(PlaceholderShapeSchema.safeParse({ mode: "absent" }).success).toBe(true);
  });

  test("preserve-host-rect requires sizeLeakAccepted: true + reason", () => {
    expect(
      PlaceholderShapeSchema.safeParse({
        mode: "preserve-host-rect",
        sizeLeakAccepted: true,
        reason: "layout parity for skeleton",
      }).success,
    ).toBe(true);
  });

  test("preserve-host-rect cannot opt into leak by omission", () => {
    expect(
      PlaceholderShapeSchema.safeParse({
        mode: "preserve-host-rect",
        reason: "x",
      }).success,
    ).toBe(false);
    // sizeLeakAccepted: false is not the accepted literal `true`
    expect(
      PlaceholderShapeSchema.safeParse({
        mode: "preserve-host-rect",
        sizeLeakAccepted: false,
        reason: "x",
      }).success,
    ).toBe(false);
  });

  test("unknown mode rejects", () => {
    expect(PlaceholderShapeSchema.safeParse({ mode: "blur" }).success).toBe(false);
  });

  test("negative or fractional dimensions reject", () => {
    expect(
      PlaceholderShapeSchema.safeParse({ mode: "synthetic", lines: -2 }).success,
    ).toBe(false);
    expect(
      PlaceholderShapeSchema.safeParse({ mode: "synthetic", lines: 1.5 }).success,
    ).toBe(false);
    expect(
      PlaceholderShapeSchema.safeParse({ mode: "synthetic", width: -10 }).success,
    ).toBe(false);
  });
});

describe("ValueSlotRefSchema", () => {
  test("valid", () => {
    expect(
      ValueSlotRefSchema.safeParse({
        resource: {
          kind: "pluginResource",
          pluginSlug: "family-album",
          resourceType: "photo",
          resourceId: "img-001",
        },
        slot: "caption",
      }).success,
    ).toBe(true);
  });

  test("empty slot rejects", () => {
    expect(
      ValueSlotRefSchema.safeParse({
        resource: {
          kind: "pluginResource",
          pluginSlug: "family-album",
          resourceType: "photo",
          resourceId: "img-001",
        },
        slot: "",
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Versioning & decisions
// ---------------------------------------------------------------------------

describe("AuthVersionsSchema", () => {
  test("valid without parentVersions", () => {
    expect(
      AuthVersionsSchema.safeParse({
        resourceAclVersion: 3,
        resourcePermissionVersion: 1,
      }).success,
    ).toBe(true);
  });

  test("valid with parentVersions", () => {
    expect(
      AuthVersionsSchema.safeParse({
        resourceAclVersion: 3,
        resourcePermissionVersion: 1,
        parentVersions: [2, 5],
      }).success,
    ).toBe(true);
  });

  test("missing version field rejects", () => {
    expect(
      AuthVersionsSchema.safeParse({ resourceAclVersion: 3 }).success,
    ).toBe(false);
  });

  test("negative or fractional versions reject", () => {
    expect(
      AuthVersionsSchema.safeParse({
        resourceAclVersion: -1,
        resourcePermissionVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      AuthVersionsSchema.safeParse({
        resourceAclVersion: 1.5,
        resourcePermissionVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      AuthVersionsSchema.safeParse({
        resourceAclVersion: 1,
        resourcePermissionVersion: 1,
        parentVersions: [2, -3],
      }).success,
    ).toBe(false);
  });
});

describe("AuthDecisionSchema", () => {
  const versions = { resourceAclVersion: 1, resourcePermissionVersion: 1 };

  test("allow decision valid", () => {
    expect(
      AuthDecisionSchema.safeParse({
        allowed: true,
        reason: "explicit-allow",
        versions,
      }).success,
    ).toBe(true);
  });

  test("fail-closed sentinel reasons valid", () => {
    for (const reason of ["unknown-resource", "unknown-action", "banned", "stale", "error"]) {
      expect(
        AuthDecisionSchema.safeParse({ allowed: false, reason, versions }).success,
      ).toBe(true);
    }
  });

  test("unknown reason rejects", () => {
    expect(
      AuthDecisionSchema.safeParse({
        allowed: false,
        reason: "vibes",
        versions,
      }).success,
    ).toBe(false);
  });

  test("missing versions rejects", () => {
    expect(
      AuthDecisionSchema.safeParse({ allowed: true, reason: "role-allow" }).success,
    ).toBe(false);
  });

  test("allowed must agree with reason", () => {
    // allow reason cannot pair with allowed: false
    expect(
      AuthDecisionSchema.safeParse({
        allowed: false,
        reason: "explicit-allow",
        versions,
      }).success,
    ).toBe(false);
    // deny / sentinel reason cannot pair with allowed: true
    expect(
      AuthDecisionSchema.safeParse({ allowed: true, reason: "banned", versions }).success,
    ).toBe(false);
    expect(
      AuthDecisionSchema.safeParse({ allowed: true, reason: "default-deny", versions }).success,
    ).toBe(false);
    // coherent pairings pass
    expect(
      AuthDecisionSchema.safeParse({ allowed: true, reason: "inherited-allow", versions }).success,
    ).toBe(true);
    expect(
      AuthDecisionSchema.safeParse({ allowed: false, reason: "role-deny", versions }).success,
    ).toBe(true);
  });
});

describe("EffectiveAclDecisionSchema", () => {
  const versions = { resourceAclVersion: 1, resourcePermissionVersion: 1 };

  test("ACL-layer reason valid", () => {
    expect(
      EffectiveAclDecisionSchema.safeParse({
        allowed: false,
        reason: "default-deny",
        versions,
      }).success,
    ).toBe(true);
  });

  test("resolver-only sentinel reason rejected at ACL layer", () => {
    // "banned" / "stale" / "error" are resolver sentinels, not ACL outcomes.
    expect(
      EffectiveAclDecisionSchema.safeParse({
        allowed: false,
        reason: "banned",
        versions,
      }).success,
    ).toBe(false);
  });

  test("allowed must agree with reason", () => {
    expect(
      EffectiveAclDecisionSchema.safeParse({
        allowed: true,
        reason: "everyone-deny",
        versions,
      }).success,
    ).toBe(false);
    expect(
      EffectiveAclDecisionSchema.safeParse({
        allowed: true,
        reason: "everyone-allow",
        versions,
      }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resolved value — visible / withheld / unsupported; secret unrepresentable
// ---------------------------------------------------------------------------

describe("ResolvedPluginResourceValueSchema", () => {
  const versions = { resourceAclVersion: 1, resourcePermissionVersion: 1 };

  test("visible carries value", () => {
    expect(
      ResolvedPluginResourceValueSchema.safeParse({
        state: "visible",
        value: { title: "Summer 2026" },
        versions,
      }).success,
    ).toBe(true);
  });

  test("withheld carries placeholder, not value", () => {
    expect(
      ResolvedPluginResourceValueSchema.safeParse({
        state: "withheld",
        placeholderShape: { mode: "synthetic", lines: 1 },
        versions,
      }).success,
    ).toBe(true);
  });

  test("unsupported carries a reason", () => {
    expect(
      ResolvedPluginResourceValueSchema.safeParse({
        state: "unsupported",
        reason: "no adapter",
      }).success,
    ).toBe(true);
  });

  test("no secret-value variant exists — a value-bearing secret rejects", () => {
    // There is no `state: "secret"` that carries a value toward a viewer.
    expect(
      ResolvedPluginResourceValueSchema.safeParse({
        state: "secret",
        value: "super-secret-token",
        versions,
      }).success,
    ).toBe(false);
  });

  test("visible without value rejects", () => {
    expect(
      ResolvedPluginResourceValueSchema.safeParse({
        state: "visible",
        versions,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Viewer context — only userId + serverId
// ---------------------------------------------------------------------------

describe("ViewerContextSchema", () => {
  test("valid", () => {
    expect(
      ViewerContextSchema.safeParse({ userId: "u1", serverId: "s1" }).success,
    ).toBe(true);
  });

  test("missing serverId rejects", () => {
    expect(ViewerContextSchema.safeParse({ userId: "u1" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Resource type registration
// ---------------------------------------------------------------------------

describe("PluginResourceTypeRegistrationSchema", () => {
  const valid = {
    pluginSlug: "family-album",
    type: "album",
    actions: ["read", "comment", "edit", "share", "admin", "family-album:download"],
    inheritableActions: ["read", "comment"],
    valueSlots: {
      title: { policy: "album.read" },
      coverImage: { policy: "album.read" },
    },
    producerValueAllowed: false,
  };

  test("valid registration", () => {
    expect(PluginResourceTypeRegistrationSchema.safeParse(valid).success).toBe(true);
  });

  test("valid with parentType + actionImplications + secret slot", () => {
    expect(
      PluginResourceTypeRegistrationSchema.safeParse({
        ...valid,
        type: "photo",
        parentType: "album",
        actionImplications: { edit: ["read"] },
        valueSlots: {
          pixels: { policy: "photo.read" },
          token: { policy: "photo.read", secret: true },
        },
      }).success,
    ).toBe(true);
  });

  test("producerValueAllowed is required — omission rejects", () => {
    const { producerValueAllowed: _omit, ...rest } = valid;
    expect(PluginResourceTypeRegistrationSchema.safeParse(rest).success).toBe(false);
  });

  test("bare unknown action in actions list rejects", () => {
    expect(
      PluginResourceTypeRegistrationSchema.safeParse({
        ...valid,
        actions: ["read", "delete"],
      }).success,
    ).toBe(false);
  });

  test("actionImplications with non-protocol key delete rejects", () => {
    expect(
      PluginResourceTypeRegistrationSchema.safeParse({
        ...valid,
        actionImplications: { delete: ["read"] },
      }).success,
    ).toBe(false);
  });

  test("valueSlots with empty string key rejects", () => {
    expect(
      PluginResourceTypeRegistrationSchema.safeParse({
        ...valid,
        valueSlots: {
          "": { policy: "x.read" },
        },
      }).success,
    ).toBe(false);
  });
});

describe("ValueSlotDefinitionSchema", () => {
  test("policy only", () => {
    expect(ValueSlotDefinitionSchema.safeParse({ policy: "album.read" }).success).toBe(true);
  });

  test("with secret flag", () => {
    expect(
      ValueSlotDefinitionSchema.safeParse({ policy: "x.read", secret: true }).success,
    ).toBe(true);
  });

  test("missing policy rejects", () => {
    expect(ValueSlotDefinitionSchema.safeParse({ secret: true }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ACL model — principals + entries
// ---------------------------------------------------------------------------

describe("ResourcePrincipalSchema", () => {
  test("user principal valid", () => {
    expect(
      ResourcePrincipalSchema.safeParse({ kind: "user", userId: "u1" }).success,
    ).toBe(true);
  });

  test("role principal valid", () => {
    expect(
      ResourcePrincipalSchema.safeParse({ kind: "role", roleId: 60 }).success,
    ).toBe(true);
  });

  test("everyone + owner valid", () => {
    expect(ResourcePrincipalSchema.safeParse({ kind: "everyone" }).success).toBe(true);
    expect(ResourcePrincipalSchema.safeParse({ kind: "owner" }).success).toBe(true);
  });

  test("user principal missing userId rejects", () => {
    expect(ResourcePrincipalSchema.safeParse({ kind: "user" }).success).toBe(false);
  });

  test("unknown principal kind rejects", () => {
    expect(ResourcePrincipalSchema.safeParse({ kind: "group" }).success).toBe(false);
  });

  test("fractional or non-positive roleId rejects", () => {
    expect(
      ResourcePrincipalSchema.safeParse({ kind: "role", roleId: 1.2 }).success,
    ).toBe(false);
    expect(
      ResourcePrincipalSchema.safeParse({ kind: "role", roleId: 0 }).success,
    ).toBe(false);
    expect(
      ResourcePrincipalSchema.safeParse({ kind: "role", roleId: -5 }).success,
    ).toBe(false);
  });
});

describe("ResourceAclEntrySchema", () => {
  const resourceKey = {
    serverId: "srv-1",
    pluginSlug: "family-album",
    resourceType: "album",
    resourceId: "summer-2026",
  };
  const valid = {
    resourceKey,
    principal: { kind: "user", userId: "billy" },
    action: "read",
    effect: "allow",
    grantedBy: "dad",
    grantedAt: 1_700_000_000_000,
    source: "explicit",
  };

  test("valid allow entry", () => {
    expect(ResourceAclEntrySchema.safeParse(valid).success).toBe(true);
  });

  test("valid deny entry with custom action", () => {
    expect(
      ResourceAclEntrySchema.safeParse({
        ...valid,
        principal: { kind: "role", roleId: 10 },
        action: "family-album:download",
        effect: "deny",
        source: "registry-seeded",
        grantedBy: "system",
      }).success,
    ).toBe(true);
  });

  test("invalid effect rejects", () => {
    expect(
      ResourceAclEntrySchema.safeParse({ ...valid, effect: "maybe" }).success,
    ).toBe(false);
  });

  test("bare unknown action rejects", () => {
    expect(
      ResourceAclEntrySchema.safeParse({ ...valid, action: "delete" }).success,
    ).toBe(false);
  });

  test("missing resourceKey field rejects", () => {
    const { serverId: _omit, ...badKey } = resourceKey;
    expect(
      ResourceAclEntrySchema.safeParse({ ...valid, resourceKey: badKey }).success,
    ).toBe(false);
  });

  test("negative or fractional grantedAt rejects", () => {
    expect(
      ResourceAclEntrySchema.safeParse({ ...valid, grantedAt: -1 }).success,
    ).toBe(false);
    expect(
      ResourceAclEntrySchema.safeParse({ ...valid, grantedAt: 1.5 }).success,
    ).toBe(false);
  });
});
