import { describe, expect, test } from "bun:test";
import { validateManifest } from "./manifest";
import type { ManifestError, ManifestResult } from "./manifest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid standalone manifest — every required field present. */
function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "my-plugin",
    version: "1.0.0",
    api_version: "^1.0",
    author: "Test Author",
    description: "A test plugin.",
    type: "standalone",
    permissions: ["data.sql:self"],
    backend: { entry: "backend/index.ts" },
    ...overrides,
  };
}

/** Minimal valid extension manifest. */
function validExtension(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...validManifest({ type: "extension", extends: "text-channels" }),
    ...overrides,
  };
}

function expectOk(result: ManifestResult) {
  if (!result.ok) {
    throw new Error(
      `Expected ok but got errors:\n${result.errors.map((e) => `  [${e.code}] ${e.field}: ${e.message}`).join("\n")}`,
    );
  }
  return result.manifest;
}

function expectErrors(result: ManifestResult): ManifestError[] {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  return result.errors;
}

function expectErrorCode(result: ManifestResult, code: string): ManifestError {
  const errs = expectErrors(result);
  const match = errs.find((e) => e.code === code);
  if (!match) {
    throw new Error(
      `Expected error code "${code}" but got: ${errs.map((e) => e.code).join(", ")}`,
    );
  }
  return match;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateManifest", () => {
  // ---- Happy path ----

  describe("valid manifests", () => {
    test("minimal standalone manifest passes", () => {
      const m = expectOk(validateManifest(validManifest()));
      expect(m.name).toBe("my-plugin");
      expect(m.type).toBe("standalone");
    });

    test("full manifest with all optional fields passes", () => {
      const m = expectOk(
        validateManifest(
          validManifest({
            license: "MIT",
            frontend: { entry: "frontend/index.html" },
            public_schema: {
              messages: {
                columns: ["id", "content"],
                description: "All messages.",
              },
            },
            dependencies: { "text-channels": "^1.0.0" },
            resources: { memory_mb: 256, cpu_weight: 2048, disk_mb: 1024 },
          }),
        ),
      );
      expect(m.license).toBe("MIT");
      expect(m.resources?.memory_mb).toBe(256);
    });

    test("core type passes", () => {
      const m = expectOk(validateManifest(validManifest({ type: "core" })));
      expect(m.type).toBe("core");
    });

    test("extension type with extends passes", () => {
      const m = expectOk(validateManifest(validExtension()));
      expect(m.type).toBe("extension");
      expect(m.extends).toBe("text-channels");
    });

    test("frontend-only plugin (no backend) passes", () => {
      const input = validManifest();
      delete input["backend"];
      input["frontend"] = { entry: "frontend/index.html" };
      expectOk(validateManifest(input));
    });

    test("backend-only plugin (no frontend) passes", () => {
      expectOk(validateManifest(validManifest()));
    });

    test("api_version without patch passes", () => {
      expectOk(validateManifest(validManifest({ api_version: "^1.0" })));
    });

    test("api_version with patch passes", () => {
      expectOk(validateManifest(validManifest({ api_version: "^1.0.0" })));
    });

    test("api_version without caret passes", () => {
      expectOk(validateManifest(validManifest({ api_version: "1.0" })));
    });
  });

  // ---- Not an object ----

  describe("input type", () => {
    test("null rejects", () => {
      expectErrorCode(validateManifest(null), "MANIFEST_NOT_OBJECT");
    });

    test("array rejects", () => {
      expectErrorCode(validateManifest([]), "MANIFEST_NOT_OBJECT");
    });

    test("string rejects", () => {
      expectErrorCode(validateManifest("hello"), "MANIFEST_NOT_OBJECT");
    });

    test("number rejects", () => {
      expectErrorCode(validateManifest(42), "MANIFEST_NOT_OBJECT");
    });

    test("undefined rejects", () => {
      expectErrorCode(validateManifest(undefined), "MANIFEST_NOT_OBJECT");
    });
  });

  // ---- Required fields ----

  describe("required fields", () => {
    const requiredFields = [
      "name",
      "version",
      "api_version",
      "author",
      "description",
      "type",
    ];

    for (const field of requiredFields) {
      test(`missing ${field} produces MISSING_FIELD`, () => {
        const input = validManifest();
        delete input[field];
        expectErrorCode(validateManifest(input), "MISSING_FIELD");
      });

      test(`empty ${field} produces EMPTY_FIELD`, () => {
        expectErrorCode(
          validateManifest(validManifest({ [field]: "" })),
          "EMPTY_FIELD",
        );
      });

      test(`non-string ${field} produces INVALID_TYPE`, () => {
        expectErrorCode(
          validateManifest(validManifest({ [field]: 123 })),
          "INVALID_TYPE",
        );
      });
    }

    test("missing permissions produces MISSING_FIELD", () => {
      const input = validManifest();
      delete input["permissions"];
      expectErrorCode(validateManifest(input), "MISSING_FIELD");
    });
  });

  // ---- name validation ----

  describe("name slug validation", () => {
    test("uppercase rejected", () => {
      expectErrorCode(validateManifest(validManifest({ name: "MyPlugin" })), "INVALID_NAME");
    });

    test("leading hyphen rejected", () => {
      expectErrorCode(validateManifest(validManifest({ name: "-plugin" })), "INVALID_NAME");
    });

    test("trailing hyphen rejected", () => {
      expectErrorCode(validateManifest(validManifest({ name: "plugin-" })), "INVALID_NAME");
    });

    test("consecutive hyphens rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ name: "my--plugin" })),
        "INVALID_NAME",
      );
    });

    test("spaces rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ name: "my plugin" })),
        "INVALID_NAME",
      );
    });

    test("leading digit rejected", () => {
      expectErrorCode(validateManifest(validManifest({ name: "1plugin" })), "INVALID_NAME");
    });

    test("underscores rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ name: "my_plugin" })),
        "INVALID_NAME",
      );
    });

    test("single letter accepted", () => {
      expectOk(validateManifest(validManifest({ name: "a" })));
    });

    test("alphanumeric with hyphens accepted", () => {
      expectOk(validateManifest(validManifest({ name: "text-channels" })));
    });

    test("name with numbers accepted", () => {
      expectOk(validateManifest(validManifest({ name: "plugin2" })));
    });
  });

  // ---- version validation ----

  describe("version validation", () => {
    test("valid semver accepted", () => {
      expectOk(validateManifest(validManifest({ version: "0.1.0" })));
    });

    test("missing patch rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ version: "1.0" })),
        "INVALID_VERSION",
      );
    });

    test("pre-release suffix rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ version: "1.0.0-beta" })),
        "INVALID_VERSION",
      );
    });

    test("build metadata rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ version: "1.0.0+build.1" })),
        "INVALID_VERSION",
      );
    });

    test("non-numeric rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ version: "abc" })),
        "INVALID_VERSION",
      );
    });
  });

  // ---- api_version validation ----

  describe("api_version validation", () => {
    test("garbage rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ api_version: "latest" })),
        "INVALID_API_VERSION",
      );
    });

    test("wildcard rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ api_version: "*" })),
        "INVALID_API_VERSION",
      );
    });

    test("tilde range rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ api_version: "~1.0" })),
        "INVALID_API_VERSION",
      );
    });
  });

  // ---- type validation ----

  describe("type validation", () => {
    test("unknown type rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ type: "widget" })),
        "INVALID_TYPE",
      );
    });

    for (const t of ["core", "standalone", "extension"] as const) {
      test(`"${t}" accepted`, () => {
        const extra = t === "extension" ? { extends: "base-plugin" } : {};
        const result = validateManifest(validManifest({ type: t, ...extra }));
        if (result.ok) {
          expect(result.manifest.type).toBe(t);
        } else {
          // Should not have a type error
          const typeErr = result.errors.find(
            (e) => e.code === "INVALID_TYPE" && e.field === "type",
          );
          expect(typeErr).toBeUndefined();
        }
      });
    }
  });

  // ---- extends ----

  describe("extends field", () => {
    test("extension without extends rejected", () => {
      const input = validManifest({ type: "extension" });
      expectErrorCode(validateManifest(input), "MISSING_EXTENDS");
    });

    test("extension with empty extends rejected", () => {
      expectErrorCode(
        validateManifest(validExtension({ extends: "" })),
        "MISSING_EXTENDS",
      );
    });

    test("extension with invalid slug in extends rejected", () => {
      expectErrorCode(
        validateManifest(validExtension({ extends: "Bad Slug" })),
        "INVALID_EXTENDS",
      );
    });

    test("standalone with extends rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ extends: "some-plugin" })),
        "UNEXPECTED_EXTENDS",
      );
    });

    test("core with extends rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ type: "core", extends: "some-plugin" })),
        "UNEXPECTED_EXTENDS",
      );
    });
  });

  // ---- permissions ----

  describe("permissions validation", () => {
    test("non-array rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ permissions: "data.sql:self" })),
        "MISSING_FIELD",
      );
    });

    test("empty array is accepted — frontend-only plugins have no IPC capabilities (G12)", () => {
      const result = validateManifest(validManifest({ permissions: [] }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.manifest.permissions).toEqual([]);
      }
    });

    test("non-string element rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ permissions: [123] })),
        "INVALID_PERMISSION",
      );
    });

    test("invalid grammar rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ permissions: ["not-a-permission"] })),
        "INVALID_PERMISSION",
      );
    });

    test("single-segment rejected (no dot)", () => {
      expectErrorCode(
        validateManifest(validManifest({ permissions: ["data"] })),
        "INVALID_PERMISSION",
      );
    });

    test("valid permissions accepted", () => {
      const perms = [
        "data.sql:self",
        "data.kv:self",
        "data.read:text-channels.messages",
        "events.publish:text-channels.*",
        "events.subscribe:runtime.cascade.*",
        "storage.file:self",
        "http.fetch:api.example.com",
        "runtime.log",
        "auth.currentUser",
      ];
      expectOk(validateManifest(validManifest({ permissions: perms })));
    });

    test("multiple invalid permissions each produce an error", () => {
      const result = validateManifest(
        validManifest({ permissions: ["bad!", "also bad"] }),
      );
      const errs = expectErrors(result);
      const permErrs = errs.filter((e) => e.code === "INVALID_PERMISSION");
      expect(permErrs.length).toBe(2);
    });

    test("data.read with bare wildcard rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ permissions: ["data.read:*"] })),
        "WILDCARD_SCOPE_DISALLOWED",
      );
    });

    test("data.read with prefix wildcard rejected", () => {
      expectErrorCode(
        validateManifest(
          validManifest({ permissions: ["data.read:text-channels.*"] }),
        ),
        "WILDCARD_SCOPE_DISALLOWED",
      );
    });

    test("data.read with specific table accepted", () => {
      expectOk(
        validateManifest(
          validManifest({ permissions: ["data.read:text-channels.messages"] }),
        ),
      );
    });

    test("events.subscribe bare wildcard rejected", () => {
      expectErrorCode(
        validateManifest(
          validManifest({ permissions: ["events.subscribe:*"] }),
        ),
        "WILDCARD_SCOPE_DISALLOWED",
      );
    });

    test("events.subscribe prefix wildcard accepted", () => {
      expectOk(
        validateManifest(
          validManifest({ permissions: ["events.subscribe:text-channels.*"] }),
        ),
      );
    });
  });

  // ---- backend ----

  describe("backend validation", () => {
    test("non-object rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ backend: "index.ts" })),
        "INVALID_BACKEND",
      );
    });

    test("missing entry rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ backend: {} })),
        "INVALID_BACKEND_ENTRY",
      );
    });

    test("empty entry rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ backend: { entry: "" } })),
        "INVALID_BACKEND_ENTRY",
      );
    });

    test("non-string entry rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ backend: { entry: 42 } })),
        "INVALID_BACKEND_ENTRY",
      );
    });
  });

  // ---- frontend ----

  describe("frontend validation", () => {
    test("non-object rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ frontend: "index.html" })),
        "INVALID_FRONTEND",
      );
    });

    test("missing entry rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ frontend: {} })),
        "INVALID_FRONTEND_ENTRY",
      );
    });

    test("empty entry rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ frontend: { entry: "" } })),
        "INVALID_FRONTEND_ENTRY",
      );
    });
  });

  // ---- no entry point ----

  describe("entry point requirement", () => {
    test("no backend and no frontend rejected", () => {
      const input = validManifest();
      delete input["backend"];
      delete input["frontend"];
      expectErrorCode(validateManifest(input), "NO_ENTRY_POINT");
    });
  });

  // ---- public_schema ----

  describe("public_schema validation", () => {
    test("non-object rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ public_schema: "bad" })),
        "INVALID_PUBLIC_SCHEMA",
      );
    });

    test("table definition not an object rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ public_schema: { messages: "bad" } })),
        "INVALID_PUBLIC_SCHEMA_TABLE",
      );
    });

    test("missing columns rejected", () => {
      expectErrorCode(
        validateManifest(
          validManifest({
            public_schema: { messages: { description: "Messages." } },
          }),
        ),
        "INVALID_PUBLIC_SCHEMA_COLUMNS",
      );
    });

    test("empty columns rejected", () => {
      expectErrorCode(
        validateManifest(
          validManifest({
            public_schema: {
              messages: { columns: [], description: "Messages." },
            },
          }),
        ),
        "EMPTY_PUBLIC_SCHEMA_COLUMNS",
      );
    });

    test("non-string column rejected", () => {
      expectErrorCode(
        validateManifest(
          validManifest({
            public_schema: {
              messages: { columns: [42], description: "Messages." },
            },
          }),
        ),
        "INVALID_PUBLIC_SCHEMA_COLUMN",
      );
    });

    test("missing description rejected", () => {
      expectErrorCode(
        validateManifest(
          validManifest({
            public_schema: { messages: { columns: ["id"] } },
          }),
        ),
        "INVALID_PUBLIC_SCHEMA_DESCRIPTION",
      );
    });

    test("empty description rejected", () => {
      expectErrorCode(
        validateManifest(
          validManifest({
            public_schema: {
              messages: { columns: ["id"], description: "" },
            },
          }),
        ),
        "INVALID_PUBLIC_SCHEMA_DESCRIPTION",
      );
    });

    test("valid public_schema accepted", () => {
      expectOk(
        validateManifest(
          validManifest({
            public_schema: {
              messages: {
                columns: ["id", "content", "created_at"],
                description: "All messages.",
              },
            },
          }),
        ),
      );
    });
  });

  // ---- dependencies ----

  describe("dependencies validation", () => {
    test("non-object rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ dependencies: [] })),
        "INVALID_DEPENDENCIES",
      );
    });

    test("invalid slug key rejected", () => {
      expectErrorCode(
        validateManifest(
          validManifest({ dependencies: { "Bad Slug": "^1.0.0" } }),
        ),
        "INVALID_DEPENDENCY_SLUG",
      );
    });

    test("invalid semver range value rejected", () => {
      expectErrorCode(
        validateManifest(
          validManifest({ dependencies: { "text-channels": "latest" } }),
        ),
        "INVALID_DEPENDENCY_RANGE",
      );
    });

    test("non-string range value rejected", () => {
      expectErrorCode(
        validateManifest(
          validManifest({ dependencies: { "text-channels": 1 } }),
        ),
        "INVALID_DEPENDENCY_RANGE",
      );
    });

    test("valid dependencies accepted", () => {
      expectOk(
        validateManifest(
          validManifest({
            dependencies: {
              "text-channels": "^1.0.0",
              members: "^2.0",
            },
          }),
        ),
      );
    });

    test("empty dependencies accepted", () => {
      expectOk(validateManifest(validManifest({ dependencies: {} })));
    });
  });

  // ---- resources ----

  describe("resources validation", () => {
    test("non-object rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ resources: 42 })),
        "INVALID_RESOURCES",
      );
    });

    test("zero memory_mb rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ resources: { memory_mb: 0 } })),
        "INVALID_RESOURCE",
      );
    });

    test("negative cpu_weight rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ resources: { cpu_weight: -1 } })),
        "INVALID_RESOURCE",
      );
    });

    test("fractional disk_mb rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ resources: { disk_mb: 512.5 } })),
        "INVALID_RESOURCE",
      );
    });

    test("string value rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ resources: { memory_mb: "128" } })),
        "INVALID_RESOURCE",
      );
    });

    test("valid resources accepted", () => {
      expectOk(
        validateManifest(
          validManifest({
            resources: { memory_mb: 128, cpu_weight: 1024, disk_mb: 512 },
          }),
        ),
      );
    });

    test("partial resources accepted", () => {
      expectOk(
        validateManifest(validManifest({ resources: { memory_mb: 256 } })),
      );
    });

    test("empty resources accepted", () => {
      expectOk(validateManifest(validManifest({ resources: {} })));
    });
  });

  // ---- license ----

  describe("license validation", () => {
    test("non-string license rejected", () => {
      expectErrorCode(
        validateManifest(validManifest({ license: 123 })),
        "INVALID_LICENSE",
      );
    });

    test("string license accepted", () => {
      expectOk(validateManifest(validManifest({ license: "MIT" })));
    });

    test("omitted license accepted", () => {
      expectOk(validateManifest(validManifest()));
    });
  });

  // ---- sidebar ----

  describe("sidebar validation", () => {
    test("sidebar.section is accepted and round-trips through the validator (G13)", () => {
      const result = validateManifest(
        validManifest({
          sidebar: { contributes: true, section: "Channels" },
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.manifest.sidebar?.section).toBe("Channels");
      }
    });

    test("non-string sidebar.section rejected (G13)", () => {
      expectErrorCode(
        validateManifest(
          validManifest({
            sidebar: { contributes: true, section: 42 },
          }),
        ),
        "INVALID_SIDEBAR_SECTION",
      );
    });

    test("omitted sidebar.section remains undefined", () => {
      const result = validateManifest(
        validManifest({ sidebar: { contributes: true } }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.manifest.sidebar?.section).toBeUndefined();
      }
    });
  });

  // ---- Multiple errors ----

  describe("multiple errors", () => {
    test("collects all errors, not just the first", () => {
      const result = validateManifest({});
      const errs = expectErrors(result);
      // Should have errors for every required field
      expect(errs.length).toBeGreaterThanOrEqual(7); // name, version, api_version, author, description, type, permissions
    });

    test("format errors and missing fields reported together", () => {
      const result = validateManifest({
        name: "BAD NAME",
        version: "not-semver",
        api_version: "*",
        author: "Test",
        description: "Test.",
        type: "invalid",
        permissions: ["bad!"],
        backend: { entry: "index.ts" },
      });
      const errs = expectErrors(result);
      const codes = errs.map((e) => e.code);
      expect(codes).toContain("INVALID_NAME");
      expect(codes).toContain("INVALID_VERSION");
      expect(codes).toContain("INVALID_API_VERSION");
      expect(codes).toContain("INVALID_TYPE");
      expect(codes).toContain("INVALID_PERMISSION");
    });
  });

  // ---- Edge cases ----

  describe("edge cases", () => {
    test("extra unknown fields are rejected (typo-resistance)", () => {
      // Validator was previously lax here; see "unknown top-level fields"
      // describe block for the strict-keys gate the kanban item added.
      const errs = expectErrors(
        validateManifest(validManifest({ custom_field: "hello", x: 42 })),
      );
      const unknown = errs.filter((e) => e.code === "UNKNOWN_FIELD");
      expect(unknown.map((e) => e.field).sort()).toEqual(["custom_field", "x"]);
    });

    test("null field values treated as missing", () => {
      expectErrorCode(
        validateManifest(validManifest({ name: null })),
        "MISSING_FIELD",
      );
    });

    test("the exact example from spec-04-plugin-architecture.md passes", () => {
      const specExample = {
        name: "text-channels",
        version: "1.2.0",
        api_version: "^1.0",
        author: "UnCorded",
        description:
          "Text-based channels with messages, mentions, edits, and deletions.",
        license: "MIT",
        type: "core",
        backend: { entry: "backend/index.ts" },
        frontend: { entry: "frontend/index.html" },
        permissions: [
          "data.kv:self",
          "data.sql:self",
          "events.publish:text-channels.*",
          "events.subscribe:runtime.cascade.*",
          "storage.file:self",
        ],
        public_schema: {
          messages: {
            columns: ["id", "channel_id", "author_id", "content", "created_at"],
            description: "All messages across all channels.",
          },
          channels: {
            columns: ["id", "name", "topic", "created_at"],
            description: "All text channels in this server.",
          },
        },
        dependencies: {},
        resources: { memory_mb: 128, cpu_weight: 1024, disk_mb: 512 },
      };
      const m = expectOk(validateManifest(specExample));
      expect(m.name).toBe("text-channels");
      expect(m.type).toBe("core");
      expect(m.permissions).toHaveLength(5);
      expect(Object.keys(m.public_schema ?? {})).toEqual([
        "messages",
        "channels",
      ]);
    });
  });

  // ---- Runtime capabilities + managed services ----

  describe("runtime_capabilities validation", () => {
    test("omitted is fine", () => {
      const m = expectOk(validateManifest(validManifest()));
      expect(m.runtime_capabilities).toBeUndefined();
    });

    test("non-array is INVALID_RUNTIME_CAPABILITIES", () => {
      expectErrorCode(
        validateManifest(validManifest({ runtime_capabilities: "voice" })),
        "INVALID_RUNTIME_CAPABILITIES",
      );
    });

    test("voice.media is recognized (PR-4 unlock)", () => {
      const m = expectOk(
        validateManifest(validManifest({ runtime_capabilities: ["voice.media"] })),
      );
      expect(m.runtime_capabilities).toEqual(["voice.media"]);
    });

    test("unknown capability is UNKNOWN_RUNTIME_CAPABILITY", () => {
      expectErrorCode(
        validateManifest(
          validManifest({ runtime_capabilities: ["voice.livekit"] }),
        ),
        "UNKNOWN_RUNTIME_CAPABILITY",
      );
    });

    test("non-string element is INVALID_RUNTIME_CAPABILITY", () => {
      expectErrorCode(
        validateManifest(validManifest({ runtime_capabilities: [123] })),
        "INVALID_RUNTIME_CAPABILITY",
      );
    });

    test("empty array passes (no unknown values)", () => {
      const m = expectOk(
        validateManifest(validManifest({ runtime_capabilities: [] })),
      );
      expect(m.runtime_capabilities).toEqual([]);
    });
  });

  describe("managed_services validation (schema-level only)", () => {
    // Note: the registry-presence check (whether a slug is actually a
    // registered managed service) lives in runtime/src/resolver.ts so it
    // can consult the runtime registry. This validator only catches
    // malformed shapes.
    test("omitted is fine", () => {
      const m = expectOk(validateManifest(validManifest()));
      expect(m.managed_services).toBeUndefined();
    });

    test("non-array is INVALID_MANAGED_SERVICES", () => {
      expectErrorCode(
        validateManifest(validManifest({ managed_services: "livekit" })),
        "INVALID_MANAGED_SERVICES",
      );
    });

    test("non-string element is INVALID_MANAGED_SERVICE", () => {
      expectErrorCode(
        validateManifest(validManifest({ managed_services: [false] })),
        "INVALID_MANAGED_SERVICE",
      );
    });

    test("empty string element is INVALID_MANAGED_SERVICE", () => {
      expectErrorCode(
        validateManifest(validManifest({ managed_services: [""] })),
        "INVALID_MANAGED_SERVICE",
      );
    });

    test("any non-empty string passes the schema layer (resolver gates registry)", () => {
      const m = expectOk(
        validateManifest(validManifest({ managed_services: ["livekit"] })),
      );
      expect(m.managed_services).toEqual(["livekit"]);
    });

    test("empty array passes", () => {
      const m = expectOk(
        validateManifest(validManifest({ managed_services: [] })),
      );
      expect(m.managed_services).toEqual([]);
    });
  });

  // ---- Unknown top-level fields ----

  describe("unknown top-level fields", () => {
    // Strict-keys gate. The validator's job is to make typos loud — without
    // this gate, `setings: [...]` (missing one 't') would be silently dropped
    // and the plugin author would think their settings UI was wired up.

    test("rejects an unknown field with UNKNOWN_FIELD", () => {
      const err = expectErrorCode(
        validateManifest(validManifest({ setings: [] })),
        "UNKNOWN_FIELD",
      );
      expect(err.field).toBe("setings");
    });

    test("rejects a typo on a recognised optional field name", () => {
      // "runtime_capabilites" is missing the trailing "i" — a real typo
      // we'd want to catch at install time, not at runtime when the
      // capability silently never activates.
      const err = expectErrorCode(
        validateManifest(validManifest({ runtime_capabilites: ["voice.media"] })),
        "UNKNOWN_FIELD",
      );
      expect(err.field).toBe("runtime_capabilites");
    });

    test("reports every unknown field, not just the first", () => {
      const errs = expectErrors(
        validateManifest(
          validManifest({ foo: 1, bar: 2, setings: [] }),
        ),
      );
      const unknown = errs.filter((e) => e.code === "UNKNOWN_FIELD");
      expect(unknown.map((e) => e.field).sort()).toEqual(["bar", "foo", "setings"]);
    });

    test("every documented optional field is on the allow-list", () => {
      // If this test ever fails, KNOWN_TOP_LEVEL_FIELDS has fallen behind
      // PluginManifest. Update the set in manifest.ts.
      expectOk(
        validateManifest(
          validManifest({
            license: "MIT",
            frontend: { entry: "frontend/index.html" },
            public_schema: { messages: { columns: ["id"], description: "x" } },
            dependencies: { "text-channels": "^1.0.0" },
            resources: { memory_mb: 128 },
            sidebar: { contributes: true },
            settings: [],
            client_capabilities: ["client.browser"],
            runtime_capabilities: ["voice.media"],
            managed_services: ["livekit"],
            serve_ready_handshake: true,
          }),
        ),
      );
    });
  });

  describe("settings field — Amendment A extensions", () => {
    // Number with min/max/step → renders as a slider in the admin UI.
    test("accepts number setting with min/max/step", () => {
      const m = expectOk(
        validateManifest(
          validManifest({
            settings: [
              { key: "max_message_length", label: "Max length", type: "number", default: 4000, min: 1, max: 10000, step: 1 },
            ],
          }),
        ),
      );
      expect(m.settings?.[0]?.min).toBe(1);
      expect(m.settings?.[0]?.max).toBe(10000);
      expect(m.settings?.[0]?.step).toBe(1);
    });

    // String with enum → renders as a select.
    test("accepts string setting with enum", () => {
      const m = expectOk(
        validateManifest(
          validManifest({
            settings: [
              { key: "theme", label: "Theme", type: "string", default: "dark", enum: ["dark", "light"] },
            ],
          }),
        ),
      );
      expect(m.settings?.[0]?.enum).toEqual(["dark", "light"]);
    });

    // String with max_length → server-enforced length cap.
    test("accepts string setting with max_length", () => {
      expectOk(
        validateManifest(
          validManifest({
            settings: [
              { key: "topic", label: "Topic", type: "string", default: "hello", max_length: 80 },
            ],
          }),
        ),
      );
    });

    test("rejects default outside min/max", () => {
      expectErrorCode(
        validateManifest(
          validManifest({
            settings: [
              { key: "n", label: "N", type: "number", default: 99999, min: 1, max: 100 },
            ],
          }),
        ),
        "INVALID_SETTING_DEFAULT",
      );
    });

    test("rejects min > max", () => {
      expectErrorCode(
        validateManifest(
          validManifest({
            settings: [
              { key: "n", label: "N", type: "number", min: 100, max: 1 },
            ],
          }),
        ),
        "INVALID_SETTING_RANGE",
      );
    });

    test("rejects enum on non-string types", () => {
      expectErrorCode(
        validateManifest(
          validManifest({
            settings: [
              { key: "n", label: "N", type: "number", enum: ["a", "b"] },
            ],
          }),
        ),
        "INVALID_SETTING_ENUM",
      );
    });

    test("rejects default not in enum", () => {
      expectErrorCode(
        validateManifest(
          validManifest({
            settings: [
              { key: "theme", label: "Theme", type: "string", default: "neon", enum: ["dark", "light"] },
            ],
          }),
        ),
        "INVALID_SETTING_DEFAULT",
      );
    });

    test("accepts number setting with stops + matching default", () => {
      const m = expectOk(
        validateManifest(
          validManifest({
            settings: [
              {
                key: "limit",
                label: "Limit",
                type: "number",
                default: 5000,
                stops: [
                  { value: 2000, label: "2k" },
                  { value: 5000, label: "5k" },
                  { value: 10000, label: "10k" },
                  { value: 0, label: "Not Guarded" },
                ],
              },
            ],
          }),
        ),
      );
      expect(m.settings?.[0]?.stops?.length).toBe(4);
    });

    test("rejects default that does not match any stop value", () => {
      expectErrorCode(
        validateManifest(
          validManifest({
            settings: [
              {
                key: "limit",
                label: "Limit",
                type: "number",
                default: 7000,
                stops: [
                  { value: 2000, label: "2k" },
                  { value: 5000, label: "5k" },
                ],
              },
            ],
          }),
        ),
        "INVALID_SETTING_DEFAULT",
      );
    });

    test("rejects stops on non-number setting", () => {
      expectErrorCode(
        validateManifest(
          validManifest({
            settings: [
              {
                key: "name",
                label: "Name",
                type: "string",
                stops: [{ value: 1, label: "one" }],
              },
            ],
          }),
        ),
        "INVALID_SETTING_STOPS",
      );
    });

    test("rejects duplicate stop values", () => {
      expectErrorCode(
        validateManifest(
          validManifest({
            settings: [
              {
                key: "limit",
                label: "Limit",
                type: "number",
                stops: [
                  { value: 5000, label: "5k" },
                  { value: 5000, label: "also 5k" },
                ],
              },
            ],
          }),
        ),
        "INVALID_SETTING_STOP",
      );
    });
  });

  describe("serve_ready_handshake field", () => {
    // Two-stage handshake opt-in. When true, the plugin starts as ready=false
    // and the runtime waits for an explicit `serve_ready` IPC frame before
    // flipping the flag (and broadcasting the runtime.plugin.ready event the
    // sidebar listens to). False or omitted = current behavior (ready on spawn).
    test("accepts serve_ready_handshake: true", () => {
      const m = expectOk(
        validateManifest(validManifest({ serve_ready_handshake: true })),
      );
      expect(m.serve_ready_handshake).toBe(true);
    });

    test("accepts serve_ready_handshake: false", () => {
      const m = expectOk(
        validateManifest(validManifest({ serve_ready_handshake: false })),
      );
      expect(m.serve_ready_handshake).toBe(false);
    });

    test("rejects non-boolean serve_ready_handshake", () => {
      const err = expectErrorCode(
        validateManifest(validManifest({ serve_ready_handshake: "yes" })),
        "INVALID_SERVE_READY_HANDSHAKE",
      );
      expect(err.field).toBe("serve_ready_handshake");
    });
  });

  // ---- proxy_mounts ----

  describe("proxy_mounts", () => {
    /** Valid manifest carrying one proxy mount + its backing setting + capability. */
    function proxyManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return validManifest({
        permissions: ["data.sql:self", "proxy.http:self"],
        settings: [{ key: "upstream_url", label: "Upstream", type: "string" }],
        proxy_mounts: [{ name: "app", upstream_setting: "upstream_url" }],
        ...overrides,
      });
    }

    test("accepts a valid proxy mount", () => {
      const m = expectOk(validateManifest(proxyManifest()));
      expect(m.proxy_mounts).toEqual([{ name: "app", upstream_setting: "upstream_url" }]);
    });

    test("accepts access members/owner and a secret upstream setting", () => {
      const m = expectOk(
        validateManifest(
          proxyManifest({
            permissions: ["proxy.websocket:self"],
            settings: [{ key: "url", label: "Upstream", type: "secret" }],
            proxy_mounts: [
              { name: "app", upstream_setting: "url", access: "members" },
              { name: "admin", upstream_setting: "url", access: "owner" },
            ],
          }),
        ),
      );
      expect(m.proxy_mounts).toHaveLength(2);
    });

    test("rejects non-array proxy_mounts", () => {
      expectErrorCode(validateManifest(proxyManifest({ proxy_mounts: {} })), "INVALID_PROXY_MOUNTS");
    });

    test("rejects empty proxy_mounts array", () => {
      expectErrorCode(validateManifest(proxyManifest({ proxy_mounts: [] })), "EMPTY_PROXY_MOUNTS");
    });

    test("rejects duplicate mount names", () => {
      expectErrorCode(
        validateManifest(
          proxyManifest({
            proxy_mounts: [
              { name: "app", upstream_setting: "upstream_url" },
              { name: "app", upstream_setting: "upstream_url" },
            ],
          }),
        ),
        "DUPLICATE_PROXY_MOUNT_NAME",
      );
    });

    test("rejects a non-slug mount name", () => {
      expectErrorCode(
        validateManifest(proxyManifest({ proxy_mounts: [{ name: "App_1", upstream_setting: "upstream_url" }] })),
        "INVALID_PROXY_MOUNT_NAME",
      );
    });

    test("rejects upstream_setting that references no declared setting", () => {
      expectErrorCode(
        validateManifest(proxyManifest({ proxy_mounts: [{ name: "app", upstream_setting: "missing" }] })),
        "UNKNOWN_UPSTREAM_SETTING",
      );
    });

    test("rejects upstream_setting of the wrong type", () => {
      expectErrorCode(
        validateManifest(
          proxyManifest({
            settings: [{ key: "port", label: "Port", type: "number" }],
            proxy_mounts: [{ name: "app", upstream_setting: "port" }],
          }),
        ),
        "INVALID_UPSTREAM_SETTING_TYPE",
      );
    });

    test("rejects an invalid access value", () => {
      expectErrorCode(
        validateManifest(
          proxyManifest({ proxy_mounts: [{ name: "app", upstream_setting: "upstream_url", access: "everyone" }] }),
        ),
        "INVALID_PROXY_MOUNT_ACCESS",
      );
    });

    test("rejects unknown mount fields", () => {
      expectErrorCode(
        validateManifest(
          proxyManifest({ proxy_mounts: [{ name: "app", upstream_setting: "upstream_url", target: "x" }] }),
        ),
        "UNKNOWN_PROXY_MOUNT_FIELD",
      );
    });

    test("accepts an in-range max_frame_bytes", () => {
      const m = expectOk(
        validateManifest(
          proxyManifest({
            proxy_mounts: [{ name: "app", upstream_setting: "upstream_url", max_frame_bytes: 1_048_576 }],
          }),
        ),
      );
      expect(m.proxy_mounts?.[0]?.max_frame_bytes).toBe(1_048_576);
    });

    test("accepts the min and max boundary values for max_frame_bytes", () => {
      expectOk(
        validateManifest(
          proxyManifest({ proxy_mounts: [{ name: "app", upstream_setting: "upstream_url", max_frame_bytes: 1024 }] }),
        ),
      );
      expectOk(
        validateManifest(
          proxyManifest({
            proxy_mounts: [{ name: "app", upstream_setting: "upstream_url", max_frame_bytes: 16 * 1024 * 1024 }],
          }),
        ),
      );
    });

    test("rejects max_frame_bytes below the floor", () => {
      expectErrorCode(
        validateManifest(
          proxyManifest({ proxy_mounts: [{ name: "app", upstream_setting: "upstream_url", max_frame_bytes: 1023 }] }),
        ),
        "INVALID_PROXY_MOUNT_MAX_FRAME_BYTES",
      );
    });

    test("rejects max_frame_bytes above the ceiling", () => {
      expectErrorCode(
        validateManifest(
          proxyManifest({
            proxy_mounts: [{ name: "app", upstream_setting: "upstream_url", max_frame_bytes: 16 * 1024 * 1024 + 1 }],
          }),
        ),
        "INVALID_PROXY_MOUNT_MAX_FRAME_BYTES",
      );
    });

    test("rejects a non-integer max_frame_bytes", () => {
      expectErrorCode(
        validateManifest(
          proxyManifest({
            proxy_mounts: [{ name: "app", upstream_setting: "upstream_url", max_frame_bytes: 65_536.5 }],
          }),
        ),
        "INVALID_PROXY_MOUNT_MAX_FRAME_BYTES",
      );
    });

    test("rejects a non-numeric max_frame_bytes", () => {
      expectErrorCode(
        validateManifest(
          proxyManifest({
            proxy_mounts: [{ name: "app", upstream_setting: "upstream_url", max_frame_bytes: "1mb" }],
          }),
        ),
        "INVALID_PROXY_MOUNT_MAX_FRAME_BYTES",
      );
    });

    test("requires a proxy.* capability when proxy_mounts present", () => {
      expectErrorCode(
        validateManifest(proxyManifest({ permissions: ["data.sql:self"] })),
        "MISSING_PROXY_CAPABILITY",
      );
    });
  });
});
