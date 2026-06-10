// Plugin manifest validator — validates manifest.json against the schema in spec-04-plugin-architecture.md

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const PLUGIN_TYPES = ["core", "standalone", "extension"] as const;
type PluginType = (typeof PLUGIN_TYPES)[number];

interface ManifestBackend {
  entry: string;
}

interface ManifestFrontend {
  entry: string;
}

interface PublicSchemaTable {
  columns: string[];
  description: string;
}

interface ManifestResources {
  memory_mb?: number;
  cpu_weight?: number;
  disk_mb?: number;
}

interface ManifestSidebar {
  contributes: boolean;
  refresh_on?: string[];
  /** Optional default section name used to group this plugin's sidebar items.
   *  If the plugin's sidebar response does not attach a `section` per item,
   *  the runtime falls back to this value so items render under a named group
   *  rather than the plugin slug. */
  section?: string;
}

/** Valid value types for a plugin setting. "secret" values are redacted from logs and diagnostics. */
export type PluginSettingType = "string" | "secret" | "number" | "boolean";

/**
 * A single admin-configurable setting declared in the manifest.
 * Values live in the plugin's `_config` table (see spec-04 Amendment A).
 * The admin panel reads this schema to render a settings form.
 */
export interface PluginSetting {
  /** Storage key. Must be unique within the plugin. */
  key: string;
  /** Human-readable label shown in the admin panel. */
  label: string;
  /** Optional longer description shown as help text. */
  description?: string;
  /**
   * Value type.
   * - "string": plain text
   * - "secret": treated as sensitive — never logged, masked in UI
   * - "number": numeric input, value stored as string representation
   * - "boolean": checkbox, stored as "true" or "false"
   */
  type: PluginSettingType;
  /** Whether the plugin requires this setting to function. Surfaced as a warning in the admin panel. */
  required?: boolean;
  /** Default value used when no value has been set. Must match the declared type. */
  default?: string | number | boolean;
  /** Lower bound for `type: "number"`. Combined with `max`, drives slider rendering. */
  min?: number;
  /** Upper bound for `type: "number"`. Combined with `min`, drives slider rendering. */
  max?: number;
  /** Slider/numeric step for `type: "number"`. Must be positive. Defaults to 1. */
  step?: number;
  /** Server-enforced length cap for `type: "string"` and `type: "secret"`. Must be positive. */
  max_length?: number;
  /** Allowed values for `type: "string"`. Renders as a select. Disallowed for secret/number. */
  enum?: string[];
  /**
   * Discrete preset values for `type: "number"`. When present, the admin UI
   * renders a stepped slider that snaps between the labelled positions
   * instead of a continuous range. The stored value is still the underlying
   * number (e.g. 0 can mean "off"/"unlimited" — interpretation is the
   * plugin's responsibility).
   */
  stops?: PluginSettingStop[];
}

export interface PluginSettingStop {
  value: number;
  label: string;
}

/** Who may access a reverse-proxy mount. Defaults to "members". */
export type ProxyMountAccess = "members" | "owner";

/**
 * Default cap on a proxied WebSocket frame (message), in bytes, when a mount
 * does not declare `max_frame_bytes`. Frames larger than the active cap close
 * the socket with 1009. 64 KiB is safe for chat-style sockets but too small for
 * apps that bulk-sync (e.g. Foundry VTT world state).
 */
export const DEFAULT_PROXY_WS_FRAME_BYTES = 64 * 1024;

/**
 * Hard ceiling on a mount's `max_frame_bytes`. Also bounds the runtime's
 * WebSocket transport payload limit, so a mount can never request a frame the
 * transport would silently drop. 16 MiB matches Bun's default `maxPayloadLength`.
 */
export const MAX_PROXY_WS_FRAME_BYTES = 16 * 1024 * 1024;

/** Floor on a mount's `max_frame_bytes` — below this the override is pointless. */
export const MIN_PROXY_WS_FRAME_BYTES = 1024;

/**
 * A reverse-proxy mount declared in the manifest. After an owner approves it,
 * the runtime serves the configured upstream under `/proxy/<slug>/<name>/*`.
 * See docs/reverse-proxy/plugin-reverse-proxy-plan.md §Manifest Contract.
 */
export interface ProxyMount {
  /** Mount name. Slug-safe and unique within the plugin; appears in the URL. */
  name: string;
  /**
   * Key of a setting declared in this same manifest (type "string" or
   * "secret") whose value holds the upstream URL. The runtime resolves and
   * normalizes that value; the manifest never carries the upstream directly.
   */
  upstream_setting: string;
  /** Access policy. Optional; defaults to "members". */
  access?: ProxyMountAccess;
  /**
   * Optional override for the maximum WebSocket frame (message) size the proxy
   * relays in either direction for this mount, in bytes. A frame larger than
   * this closes the socket with 1009. Defaults to {@link DEFAULT_PROXY_WS_FRAME_BYTES}
   * (64 KiB) when unset; raise it for real-time apps that bulk-sync (Foundry VTT
   * world state, dashboards). Must be an integer between
   * {@link MIN_PROXY_WS_FRAME_BYTES} (1 KiB) and {@link MAX_PROXY_WS_FRAME_BYTES} (16 MiB).
   */
  max_frame_bytes?: number;
}

export interface PluginManifest {
  name: string;
  version: string;
  api_version: string;
  author: string;
  description: string;
  license?: string;
  type: PluginType;
  extends?: string;
  /**
   * Optional icon shown in the admin Plugins panel. For Phase 2 this is a
   * lucide-icon name (e.g. "Hash", "Volume2"). Unknown names render as the
   * default placeholder square — the host UI is responsible for the
   * name → component lookup.
   */
  icon?: string;
  backend?: ManifestBackend;
  frontend?: ManifestFrontend;
  permissions: string[];
  public_schema?: Record<string, PublicSchemaTable>;
  dependencies?: Record<string, string>;
  resources?: ManifestResources;
  sidebar?: ManifestSidebar;
  /** Admin-configurable settings. Values are stored in the plugin's KV store. */
  settings?: PluginSetting[];
  /**
   * Client capabilities this plugin requires.
   * Valid Phase 2 values: ["client.browser"]
   * Used by the shell to render install prompts when the capability is unavailable.
   */
  client_capabilities?: string[];
  /**
   * Runtime capabilities the plugin opts into. Reserved name set is defined in
   * spec-24 (capability + managed-service framework). Unknown values are
   * rejected at manifest validation; declaring a capability here gates the
   * plugin's access to the corresponding runtime API.
   *
   * Valid values:
   *   - "voice.media" — voice-channels plugin; gates LiveKit-mediated audio.
   *   - "voice.screen_share" — PR-6: gates the plugin's ability to grant
   *     screen-share publish to its users. Per-user authorization is a
   *     separate plugin permission (`voice.screen_share.publish`).
   *   - "voice.moderation" — PR-6: gates admin "Stop their share" via
   *     LiveKit `RemoveParticipant`. Per-user authorization is a separate
   *     plugin permission (`voice.moderation.stop_share`).
   */
  runtime_capabilities?: string[];
  /**
   * Managed sidecar services the plugin requests the runtime to start and
   * supervise on its behalf. Each value is a registered service slug; the
   * runtime owns the process lifecycle and the plugin connects via a
   * service-specific transport.
   *
   * Valid values:
   *   - "livekit" — bundled LiveKit supervisor (registered by the voice
   *     subsystem at module init).
   */
  managed_services?: string[];
  /**
   * Opt into the two-stage handshake. When true, the plugin starts as
   * not-ready-to-serve in the runtime registry and the web client greys
   * out the plugin's sidebar items until the plugin explicitly calls
   * `sdk.serveReady()`. When false (default), the plugin is treated as
   * ready immediately on spawn — preserves current behavior.
   *
   * Use this when the plugin needs to hydrate caches, prefetch state from
   * external services, or run any post-spawn initialization that must
   * complete before user requests can be served. Without it, a freshly
   * provisioned server may surface clickable channel rows before the
   * plugin can answer them — the join silently fails and the user walks.
   */
  serve_ready_handshake?: boolean;
  /**
   * Reverse-proxy mounts. Optional; when present must be a non-empty array and
   * the plugin must request at least one of `proxy.http:self` /
   * `proxy.websocket:self` in `permissions`. Each mount is disabled until an
   * owner approves it (see the runtime-owned approval store).
   */
  proxy_mounts?: ProxyMount[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ManifestError {
  code: string;
  field: string;
  message: string;
}

export type ManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: ManifestError[] };

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Lowercase alphanumeric with hyphens, no leading/trailing/consecutive hyphens */
const SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Strict semver: MAJOR.MINOR.PATCH (no pre-release/build metadata for now) */
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** Semver range used in api_version and dependencies: ^MAJOR.MINOR or ^MAJOR.MINOR.PATCH */
const SEMVER_RANGE_RE = /^\^?\d+\.\d+(?:\.\d+)?$/;

/**
 * Permission grammar from the spec: resource.action[:scope]
 * resource and action are dotted identifiers; scope is optional and may contain
 * dots, colons, and wildcards.
 *
 * Examples:
 *   data.sql:self
 *   events.publish:text-channels.*
 *   http.fetch:api.example.com
 *   auth.currentUser
 *   runtime.log
 */
const PERMISSION_RE = /^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*(?::[a-z0-9*][a-z0-9.*:-]*)?$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Every top-level field validateManifest knows about. Anything outside this
 * set is rejected as UNKNOWN_FIELD so a typo on an optional field
 * (`setings`, `dependancies`, `resoruces`, `runtime_capabilites`) fails
 * loudly at install time instead of being silently ignored — the silent
 * path looks like the plugin is configured when it isn't.
 *
 * When you add a new top-level key to PluginManifest, add it here.
 */
const KNOWN_TOP_LEVEL_FIELDS = new Set<string>([
  "name",
  "version",
  "api_version",
  "author",
  "description",
  "license",
  "type",
  "extends",
  "icon",
  "backend",
  "frontend",
  "permissions",
  "public_schema",
  "dependencies",
  "resources",
  "sidebar",
  "settings",
  "client_capabilities",
  "runtime_capabilities",
  "managed_services",
  "serve_ready_handshake",
  "proxy_mounts",
]);

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export function validateManifest(input: unknown): ManifestResult {
  const errors: ManifestError[] = [];

  // Must be a plain object
  if (!isObject(input)) {
    return {
      ok: false,
      errors: [
        {
          code: "MANIFEST_NOT_OBJECT",
          field: "",
          message: "Manifest must be a JSON object.",
        },
      ],
    };
  }

  // --- Reject unknown top-level keys ---
  // Typo-resistance: a misspelled optional field (e.g. "setings" or
  // "runtime_capabilites") would otherwise be silently dropped, leaving the
  // plugin author convinced their setting is wired up. Reject loudly.
  for (const key of Object.keys(input)) {
    if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) {
      errors.push({
        code: "UNKNOWN_FIELD",
        field: key,
        message: `Unknown top-level field "${key}". If this is a new manifest field, add it to KNOWN_TOP_LEVEL_FIELDS in packages/shared/src/manifest.ts; otherwise check for a typo.`,
      });
    }
  }

  // --- Required string fields ---

  validateRequiredString(input, "name", errors);
  validateRequiredString(input, "version", errors);
  validateRequiredString(input, "api_version", errors);
  validateRequiredString(input, "author", errors);
  validateRequiredString(input, "description", errors);
  validateRequiredString(input, "type", errors);

  // --- name: must be a valid slug ---
  if (typeof input["name"] === "string" && !SLUG_RE.test(input["name"])) {
    errors.push({
      code: "INVALID_NAME",
      field: "name",
      message:
        "name must be a lowercase slug (a-z, 0-9, hyphens). No leading/trailing hyphens or consecutive hyphens.",
    });
  }

  // --- version: strict semver ---
  if (typeof input["version"] === "string" && !SEMVER_RE.test(input["version"])) {
    errors.push({
      code: "INVALID_VERSION",
      field: "version",
      message: "version must be a valid semver string (MAJOR.MINOR.PATCH).",
    });
  }

  // --- api_version: semver range ---
  if (
    typeof input["api_version"] === "string" &&
    !SEMVER_RANGE_RE.test(input["api_version"])
  ) {
    errors.push({
      code: "INVALID_API_VERSION",
      field: "api_version",
      message:
        "api_version must be a semver range (e.g. ^1.0 or ^1.0.0).",
    });
  }

  // --- type: must be one of the known types ---
  if (
    typeof input["type"] === "string" &&
    !(PLUGIN_TYPES as readonly string[]).includes(input["type"])
  ) {
    errors.push({
      code: "INVALID_TYPE",
      field: "type",
      message: `type must be one of: ${PLUGIN_TYPES.join(", ")}.`,
    });
  }

  // --- extends: required for extension, forbidden for others ---
  const pluginType = input["type"];
  if (pluginType === "extension") {
    if (typeof input["extends"] !== "string" || input["extends"].length === 0) {
      errors.push({
        code: "MISSING_EXTENDS",
        field: "extends",
        message:
          "extends is required when type is 'extension'. Must be the slug of the base plugin.",
      });
    } else if (!SLUG_RE.test(input["extends"])) {
      errors.push({
        code: "INVALID_EXTENDS",
        field: "extends",
        message: "extends must be a valid plugin slug.",
      });
    }
  } else if (input["extends"] !== undefined) {
    errors.push({
      code: "UNEXPECTED_EXTENDS",
      field: "extends",
      message: "extends must only be set when type is 'extension'.",
    });
  }

  // --- permissions: required array of valid capability strings ---
  if (!Array.isArray(input["permissions"])) {
    errors.push({
      code: "MISSING_FIELD",
      field: "permissions",
      message: "permissions is required and must be an array.",
    });
  } else {
    // Empty arrays are accepted — frontend-only plugins don't need any IPC
    // capabilities (no backend, no DB, no http.fetch). Blocking them here
    // rejects a legitimate class of plugin.
    for (let i = 0; i < input["permissions"].length; i++) {
      const perm = input["permissions"][i];
      if (typeof perm !== "string") {
        errors.push({
          code: "INVALID_PERMISSION",
          field: `permissions[${i}]`,
          message: `permissions[${i}] must be a string.`,
        });
      } else if (!PERMISSION_RE.test(perm)) {
        errors.push({
          code: "INVALID_PERMISSION",
          field: `permissions[${i}]`,
          message: `permissions[${i}] ("${perm}") does not match the capability grammar: resource.action[:scope].`,
        });
      } else {
        // Wildcard scope policy — the CapabilityChecker honors `*` and `prefix.*`
        // per the spec, but blanket scopes are an attack-surface lever a third
        // party plugin shouldn't get at install time:
        //   - data.read   — no wildcards at all. Cross-plugin reads must name a
        //                   specific public_schema table; `data.read:*` would
        //                   silently grant access to every other plugin's
        //                   exported data. Any future relaxation goes through
        //                   manifest validation, not CapabilityChecker.
        //   - events.subscribe — bare `*` (every topic on the bus) is rejected.
        //                   Prefix wildcards like `text-channels.*` are kept,
        //                   since they're how plugins legitimately fan-in
        //                   another plugin's events.
        const colonIndex = perm.indexOf(":");
        if (colonIndex !== -1) {
          const resourceAction = perm.slice(0, colonIndex);
          const scope = perm.slice(colonIndex + 1);
          if (resourceAction === "data.read" && scope.includes("*")) {
            errors.push({
              code: "WILDCARD_SCOPE_DISALLOWED",
              field: `permissions[${i}]`,
              message: `permissions[${i}] ("${perm}"): data.read does not allow wildcard scopes; name a specific table.`,
            });
          } else if (resourceAction === "events.subscribe" && scope === "*") {
            errors.push({
              code: "WILDCARD_SCOPE_DISALLOWED",
              field: `permissions[${i}]`,
              message: `permissions[${i}] ("${perm}"): events.subscribe requires a topic prefix (e.g. "text-channels.*"), not bare "*".`,
            });
          }
        }
      }
    }
  }

  // --- backend (optional object with required entry) ---
  if (input["backend"] !== undefined) {
    if (!isObject(input["backend"])) {
      errors.push({
        code: "INVALID_BACKEND",
        field: "backend",
        message: "backend must be an object with an 'entry' string.",
      });
    } else {
      const be = input["backend"];
      if (typeof be["entry"] !== "string" || be["entry"].length === 0) {
        errors.push({
          code: "INVALID_BACKEND_ENTRY",
          field: "backend.entry",
          message: "backend.entry must be a non-empty string.",
        });
      }
    }
  }

  // --- frontend (optional object with required entry) ---
  if (input["frontend"] !== undefined) {
    if (!isObject(input["frontend"])) {
      errors.push({
        code: "INVALID_FRONTEND",
        field: "frontend",
        message: "frontend must be an object with an 'entry' string.",
      });
    } else {
      const fe = input["frontend"];
      if (typeof fe["entry"] !== "string" || fe["entry"].length === 0) {
        errors.push({
          code: "INVALID_FRONTEND_ENTRY",
          field: "frontend.entry",
          message: "frontend.entry must be a non-empty string.",
        });
      }
    }
  }

  // --- At least one of backend or frontend must exist ---
  if (input["backend"] === undefined && input["frontend"] === undefined) {
    errors.push({
      code: "NO_ENTRY_POINT",
      field: "",
      message:
        "A plugin must have at least one of backend or frontend.",
    });
  }

  // --- public_schema (optional) ---
  if (input["public_schema"] !== undefined) {
    if (!isObject(input["public_schema"])) {
      errors.push({
        code: "INVALID_PUBLIC_SCHEMA",
        field: "public_schema",
        message: "public_schema must be an object.",
      });
    } else {
      for (const [table, def] of Object.entries(input["public_schema"])) {
        const prefix = `public_schema.${table}`;
        if (!isObject(def)) {
          errors.push({
            code: "INVALID_PUBLIC_SCHEMA_TABLE",
            field: prefix,
            message: `${prefix} must be an object with 'columns' and 'description'.`,
          });
          continue;
        }
        if (!Array.isArray(def["columns"])) {
          errors.push({
            code: "INVALID_PUBLIC_SCHEMA_COLUMNS",
            field: `${prefix}.columns`,
            message: `${prefix}.columns must be an array of strings.`,
          });
        } else {
          for (let i = 0; i < def["columns"].length; i++) {
            if (typeof def["columns"][i] !== "string") {
              errors.push({
                code: "INVALID_PUBLIC_SCHEMA_COLUMN",
                field: `${prefix}.columns[${i}]`,
                message: `${prefix}.columns[${i}] must be a string.`,
              });
            }
          }
          if (def["columns"].length === 0) {
            errors.push({
              code: "EMPTY_PUBLIC_SCHEMA_COLUMNS",
              field: `${prefix}.columns`,
              message: `${prefix}.columns must not be empty.`,
            });
          }
        }
        if (typeof def["description"] !== "string" || def["description"].length === 0) {
          errors.push({
            code: "INVALID_PUBLIC_SCHEMA_DESCRIPTION",
            field: `${prefix}.description`,
            message: `${prefix}.description must be a non-empty string.`,
          });
        }
      }
    }
  }

  // --- dependencies (optional) ---
  if (input["dependencies"] !== undefined) {
    if (!isObject(input["dependencies"])) {
      errors.push({
        code: "INVALID_DEPENDENCIES",
        field: "dependencies",
        message: "dependencies must be an object mapping plugin slugs to semver ranges.",
      });
    } else {
      for (const [slug, range] of Object.entries(input["dependencies"])) {
        if (!SLUG_RE.test(slug)) {
          errors.push({
            code: "INVALID_DEPENDENCY_SLUG",
            field: `dependencies.${slug}`,
            message: `dependencies key "${slug}" is not a valid plugin slug.`,
          });
        }
        if (typeof range !== "string" || !SEMVER_RANGE_RE.test(range)) {
          errors.push({
            code: "INVALID_DEPENDENCY_RANGE",
            field: `dependencies.${slug}`,
            message: `dependencies["${slug}"] must be a valid semver range.`,
          });
        }
      }
    }
  }

  // --- resources (optional) ---
  if (input["resources"] !== undefined) {
    if (!isObject(input["resources"])) {
      errors.push({
        code: "INVALID_RESOURCES",
        field: "resources",
        message: "resources must be an object.",
      });
    } else {
      validatePositiveInt(input["resources"], "memory_mb", "resources.memory_mb", errors);
      validatePositiveInt(input["resources"], "cpu_weight", "resources.cpu_weight", errors);
      validatePositiveInt(input["resources"], "disk_mb", "resources.disk_mb", errors);
    }
  }

  // --- sidebar (optional) ---
  if (input["sidebar"] !== undefined) {
    if (!isObject(input["sidebar"])) {
      errors.push({
        code: "INVALID_SIDEBAR",
        field: "sidebar",
        message: "sidebar must be an object.",
      });
    } else {
      const sb = input["sidebar"];
      if (typeof sb["contributes"] !== "boolean") {
        errors.push({
          code: "INVALID_SIDEBAR_CONTRIBUTES",
          field: "sidebar.contributes",
          message: "sidebar.contributes must be a boolean.",
        });
      }
      if (sb["refresh_on"] !== undefined) {
        if (!Array.isArray(sb["refresh_on"])) {
          errors.push({
            code: "INVALID_SIDEBAR_REFRESH_ON",
            field: "sidebar.refresh_on",
            message: "sidebar.refresh_on must be an array of topic strings.",
          });
        } else {
          for (let i = 0; i < sb["refresh_on"].length; i++) {
            if (typeof sb["refresh_on"][i] !== "string") {
              errors.push({
                code: "INVALID_SIDEBAR_REFRESH_ON_ITEM",
                field: `sidebar.refresh_on[${i}]`,
                message: `sidebar.refresh_on[${i}] must be a string.`,
              });
            }
          }
        }
      }
      if (sb["section"] !== undefined && typeof sb["section"] !== "string") {
        errors.push({
          code: "INVALID_SIDEBAR_SECTION",
          field: "sidebar.section",
          message: "sidebar.section must be a string.",
        });
      }
    }
  }

  // --- settings (optional array of PluginSetting) ---
  if (input["settings"] !== undefined) {
    if (!Array.isArray(input["settings"])) {
      errors.push({
        code: "INVALID_SETTINGS",
        field: "settings",
        message: "settings must be an array.",
      });
    } else {
      const SETTING_TYPES = new Set(["string", "secret", "number", "boolean"]);
      for (let i = 0; i < input["settings"].length; i++) {
        const s = input["settings"][i];
        const prefix = `settings[${i}]`;
        if (!isObject(s)) {
          errors.push({ code: "INVALID_SETTING", field: prefix, message: `${prefix} must be an object.` });
          continue;
        }
        // key: non-empty string, max 256 chars
        if (typeof s["key"] !== "string" || s["key"].length === 0) {
          errors.push({ code: "INVALID_SETTING_KEY", field: `${prefix}.key`, message: `${prefix}.key must be a non-empty string.` });
        } else if (s["key"].length > 256) {
          errors.push({ code: "INVALID_SETTING_KEY", field: `${prefix}.key`, message: `${prefix}.key must not exceed 256 characters.` });
        }
        // label: non-empty string
        if (typeof s["label"] !== "string" || s["label"].length === 0) {
          errors.push({ code: "INVALID_SETTING_LABEL", field: `${prefix}.label`, message: `${prefix}.label must be a non-empty string.` });
        }
        // description: optional string
        if (s["description"] !== undefined && typeof s["description"] !== "string") {
          errors.push({ code: "INVALID_SETTING_DESCRIPTION", field: `${prefix}.description`, message: `${prefix}.description must be a string if provided.` });
        }
        // type: must be one of the known types
        if (typeof s["type"] !== "string" || !SETTING_TYPES.has(s["type"])) {
          errors.push({ code: "INVALID_SETTING_TYPE", field: `${prefix}.type`, message: `${prefix}.type must be one of: string, secret, number, boolean.` });
        }
        // required: optional boolean
        if (s["required"] !== undefined && typeof s["required"] !== "boolean") {
          errors.push({ code: "INVALID_SETTING_REQUIRED", field: `${prefix}.required`, message: `${prefix}.required must be a boolean if provided.` });
        }
        // default: optional, type must match declared type
        const settingType = s["type"];
        if (s["default"] !== undefined) {
          const defVal = s["default"];
          const validDefault =
            (settingType === "string" || settingType === "secret") ? typeof defVal === "string" :
            settingType === "number" ? typeof defVal === "number" :
            settingType === "boolean" ? typeof defVal === "boolean" :
            false;
          if (!validDefault) {
            errors.push({ code: "INVALID_SETTING_DEFAULT", field: `${prefix}.default`, message: `${prefix}.default type does not match declared type "${String(settingType)}".` });
          }
        }
        // min/max/step/max_length/enum extensions (spec-04 Amendment A)
        const minVal = s["min"];
        const maxVal = s["max"];
        const stepVal = s["step"];
        const maxLenVal = s["max_length"];
        const enumVal = s["enum"];
        if (minVal !== undefined) {
          if (typeof minVal !== "number" || !Number.isFinite(minVal)) {
            errors.push({ code: "INVALID_SETTING_MIN", field: `${prefix}.min`, message: `${prefix}.min must be a finite number.` });
          } else if (settingType !== "number") {
            errors.push({ code: "INVALID_SETTING_MIN", field: `${prefix}.min`, message: `${prefix}.min only applies to type "number".` });
          }
        }
        if (maxVal !== undefined) {
          if (typeof maxVal !== "number" || !Number.isFinite(maxVal)) {
            errors.push({ code: "INVALID_SETTING_MAX", field: `${prefix}.max`, message: `${prefix}.max must be a finite number.` });
          } else if (settingType !== "number") {
            errors.push({ code: "INVALID_SETTING_MAX", field: `${prefix}.max`, message: `${prefix}.max only applies to type "number".` });
          }
        }
        if (typeof minVal === "number" && typeof maxVal === "number" && minVal > maxVal) {
          errors.push({ code: "INVALID_SETTING_RANGE", field: `${prefix}.min`, message: `${prefix}.min must be <= ${prefix}.max.` });
        }
        if (stepVal !== undefined) {
          if (typeof stepVal !== "number" || !Number.isFinite(stepVal) || stepVal <= 0) {
            errors.push({ code: "INVALID_SETTING_STEP", field: `${prefix}.step`, message: `${prefix}.step must be a positive number.` });
          } else if (settingType !== "number") {
            errors.push({ code: "INVALID_SETTING_STEP", field: `${prefix}.step`, message: `${prefix}.step only applies to type "number".` });
          }
        }
        if (maxLenVal !== undefined) {
          if (typeof maxLenVal !== "number" || !Number.isInteger(maxLenVal) || maxLenVal <= 0) {
            errors.push({ code: "INVALID_SETTING_MAX_LENGTH", field: `${prefix}.max_length`, message: `${prefix}.max_length must be a positive integer.` });
          } else if (settingType !== "string" && settingType !== "secret") {
            errors.push({ code: "INVALID_SETTING_MAX_LENGTH", field: `${prefix}.max_length`, message: `${prefix}.max_length only applies to type "string" or "secret".` });
          }
        }
        if (enumVal !== undefined) {
          if (!Array.isArray(enumVal) || enumVal.length === 0 || !enumVal.every((e) => typeof e === "string")) {
            errors.push({ code: "INVALID_SETTING_ENUM", field: `${prefix}.enum`, message: `${prefix}.enum must be a non-empty array of strings.` });
          } else if (settingType !== "string") {
            errors.push({ code: "INVALID_SETTING_ENUM", field: `${prefix}.enum`, message: `${prefix}.enum only applies to type "string".` });
          }
        }
        // stops: array of {value: number, label: string}; type:"number" only
        const stopsVal = s["stops"];
        if (stopsVal !== undefined) {
          if (!Array.isArray(stopsVal) || stopsVal.length === 0) {
            errors.push({ code: "INVALID_SETTING_STOPS", field: `${prefix}.stops`, message: `${prefix}.stops must be a non-empty array.` });
          } else if (settingType !== "number") {
            errors.push({ code: "INVALID_SETTING_STOPS", field: `${prefix}.stops`, message: `${prefix}.stops only applies to type "number".` });
          } else {
            const seen = new Set<number>();
            for (let j = 0; j < stopsVal.length; j++) {
              const stop = stopsVal[j];
              if (!isObject(stop)) {
                errors.push({ code: "INVALID_SETTING_STOP", field: `${prefix}.stops[${j}]`, message: `${prefix}.stops[${j}] must be an object.` });
                continue;
              }
              if (typeof stop["value"] !== "number" || !Number.isFinite(stop["value"])) {
                errors.push({ code: "INVALID_SETTING_STOP", field: `${prefix}.stops[${j}].value`, message: `${prefix}.stops[${j}].value must be a finite number.` });
              } else if (seen.has(stop["value"])) {
                errors.push({ code: "INVALID_SETTING_STOP", field: `${prefix}.stops[${j}].value`, message: `${prefix}.stops[${j}].value (${stop["value"]}) is duplicated.` });
              } else {
                seen.add(stop["value"]);
              }
              if (typeof stop["label"] !== "string" || stop["label"].length === 0) {
                errors.push({ code: "INVALID_SETTING_STOP", field: `${prefix}.stops[${j}].label`, message: `${prefix}.stops[${j}].label must be a non-empty string.` });
              }
            }
          }
        }
        // default must satisfy min/max/max_length/enum when both present and types align
        if (s["default"] !== undefined && settingType === "number" && typeof s["default"] === "number") {
          if (typeof minVal === "number" && s["default"] < minVal) {
            errors.push({ code: "INVALID_SETTING_DEFAULT", field: `${prefix}.default`, message: `${prefix}.default (${s["default"]}) must be >= min (${minVal}).` });
          }
          if (typeof maxVal === "number" && s["default"] > maxVal) {
            errors.push({ code: "INVALID_SETTING_DEFAULT", field: `${prefix}.default`, message: `${prefix}.default (${s["default"]}) must be <= max (${maxVal}).` });
          }
          if (Array.isArray(stopsVal) && stopsVal.length > 0) {
            const stopValues = stopsVal
              .filter((st): st is { value: number; label: string } => isObject(st) && typeof st["value"] === "number")
              .map((st) => st.value);
            if (!stopValues.includes(s["default"])) {
              errors.push({ code: "INVALID_SETTING_DEFAULT", field: `${prefix}.default`, message: `${prefix}.default (${s["default"]}) must match one of the stop values.` });
            }
          }
        }
        if (s["default"] !== undefined && (settingType === "string" || settingType === "secret") && typeof s["default"] === "string") {
          if (typeof maxLenVal === "number" && s["default"].length > maxLenVal) {
            errors.push({ code: "INVALID_SETTING_DEFAULT", field: `${prefix}.default`, message: `${prefix}.default length must be <= max_length (${maxLenVal}).` });
          }
        }
        if (s["default"] !== undefined && settingType === "string" && typeof s["default"] === "string" && Array.isArray(enumVal)) {
          if (!enumVal.includes(s["default"])) {
            errors.push({ code: "INVALID_SETTING_DEFAULT", field: `${prefix}.default`, message: `${prefix}.default must be one of the enum values.` });
          }
        }
      }
    }
  }

  // --- proxy_mounts (optional non-empty array of ProxyMount) ---
  // See docs/reverse-proxy/plugin-reverse-proxy-plan.md §Manifest Contract.
  if (input["proxy_mounts"] !== undefined) {
    if (!Array.isArray(input["proxy_mounts"])) {
      errors.push({
        code: "INVALID_PROXY_MOUNTS",
        field: "proxy_mounts",
        message: "proxy_mounts must be an array.",
      });
    } else if (input["proxy_mounts"].length === 0) {
      errors.push({
        code: "EMPTY_PROXY_MOUNTS",
        field: "proxy_mounts",
        message: "proxy_mounts must not be empty when present.",
      });
    } else {
      // Build a key -> type lookup over declared settings so each mount's
      // upstream_setting can be cross-referenced against a same-manifest
      // string|secret setting.
      const settingTypeByKey = new Map<string, string>();
      if (Array.isArray(input["settings"])) {
        for (const s of input["settings"]) {
          if (isObject(s) && typeof s["key"] === "string" && typeof s["type"] === "string") {
            settingTypeByKey.set(s["key"], s["type"]);
          }
        }
      }
      const ALLOWED_MOUNT_ACCESS = new Set(["members", "owner"]);
      const KNOWN_MOUNT_FIELDS = new Set(["name", "upstream_setting", "access", "max_frame_bytes"]);
      const seenMountNames = new Set<string>();
      for (let i = 0; i < input["proxy_mounts"].length; i++) {
        const m = input["proxy_mounts"][i];
        const prefix = `proxy_mounts[${i}]`;
        if (!isObject(m)) {
          errors.push({ code: "INVALID_PROXY_MOUNT", field: prefix, message: `${prefix} must be an object.` });
          continue;
        }
        // Reject unknown mount fields — a typo here would silently disable a mount.
        for (const k of Object.keys(m)) {
          if (!KNOWN_MOUNT_FIELDS.has(k)) {
            errors.push({ code: "UNKNOWN_PROXY_MOUNT_FIELD", field: `${prefix}.${k}`, message: `${prefix}.${k} is not a recognized proxy mount field.` });
          }
        }
        // name: slug-safe and unique within the plugin.
        if (typeof m["name"] !== "string" || m["name"].length === 0) {
          errors.push({ code: "INVALID_PROXY_MOUNT_NAME", field: `${prefix}.name`, message: `${prefix}.name must be a non-empty string.` });
        } else if (!SLUG_RE.test(m["name"])) {
          errors.push({ code: "INVALID_PROXY_MOUNT_NAME", field: `${prefix}.name`, message: `${prefix}.name must be a lowercase slug (a-z, 0-9, single hyphens).` });
        } else if (seenMountNames.has(m["name"])) {
          errors.push({ code: "DUPLICATE_PROXY_MOUNT_NAME", field: `${prefix}.name`, message: `${prefix}.name ("${m["name"]}") is duplicated; mount names must be unique per plugin.` });
        } else {
          seenMountNames.add(m["name"]);
        }
        // upstream_setting: references a declared string|secret setting.
        if (typeof m["upstream_setting"] !== "string" || m["upstream_setting"].length === 0) {
          errors.push({ code: "INVALID_PROXY_MOUNT_UPSTREAM_SETTING", field: `${prefix}.upstream_setting`, message: `${prefix}.upstream_setting must be a non-empty string.` });
        } else {
          const refType = settingTypeByKey.get(m["upstream_setting"]);
          if (refType === undefined) {
            errors.push({ code: "UNKNOWN_UPSTREAM_SETTING", field: `${prefix}.upstream_setting`, message: `${prefix}.upstream_setting ("${m["upstream_setting"]}") does not reference a setting declared in this manifest.` });
          } else if (refType !== "string" && refType !== "secret") {
            errors.push({ code: "INVALID_UPSTREAM_SETTING_TYPE", field: `${prefix}.upstream_setting`, message: `${prefix}.upstream_setting must reference a setting of type "string" or "secret" (found "${refType}").` });
          }
        }
        // access: optional; one of members|owner.
        if (m["access"] !== undefined && (typeof m["access"] !== "string" || !ALLOWED_MOUNT_ACCESS.has(m["access"]))) {
          errors.push({ code: "INVALID_PROXY_MOUNT_ACCESS", field: `${prefix}.access`, message: `${prefix}.access must be one of: members, owner.` });
        }
        // max_frame_bytes: optional WebSocket frame cap; integer within bounds.
        if (m["max_frame_bytes"] !== undefined) {
          const v = m["max_frame_bytes"];
          if (
            typeof v !== "number" ||
            !Number.isInteger(v) ||
            v < MIN_PROXY_WS_FRAME_BYTES ||
            v > MAX_PROXY_WS_FRAME_BYTES
          ) {
            errors.push({
              code: "INVALID_PROXY_MOUNT_MAX_FRAME_BYTES",
              field: `${prefix}.max_frame_bytes`,
              message: `${prefix}.max_frame_bytes must be an integer between ${String(MIN_PROXY_WS_FRAME_BYTES)} and ${String(MAX_PROXY_WS_FRAME_BYTES)} (bytes).`,
            });
          }
        }
      }
      // A plugin declaring proxy mounts must request a proxy transport
      // capability. WebSocket is its own capability and is not implied by HTTP.
      if (Array.isArray(input["permissions"])) {
        const hasProxyCapability = input["permissions"].some(
          (p) => p === "proxy.http:self" || p === "proxy.websocket:self",
        );
        if (!hasProxyCapability) {
          errors.push({
            code: "MISSING_PROXY_CAPABILITY",
            field: "permissions",
            message: 'A plugin declaring proxy_mounts must request at least one of "proxy.http:self" or "proxy.websocket:self" in permissions.',
          });
        }
      }
    }
  }

  // --- license (optional string) ---
  if (input["license"] !== undefined && typeof input["license"] !== "string") {
    errors.push({
      code: "INVALID_LICENSE",
      field: "license",
      message: "license must be a string if provided.",
    });
  }

  // --- runtime_capabilities (optional array of strings, strict set) ---
  // The contract: an unknown value is a hard reject, never a silent drop.
  // PR-4 (voice) unlocks `voice.media` — declared by the voice-channels
  // plugin so the runtime knows to manage the bundled LiveKit supervisor.
  // PR-6 (screen share) unlocks `voice.screen_share` (gates the plugin's
  // ability to derive `canPublishSources` for screen+screen-audio) and
  // `voice.moderation` (gates admin "Stop their share" via the room-service
  // RemoveParticipant Twirp call).
  const VALID_RUNTIME_CAPABILITIES = new Set<string>([
    "voice.media",
    "voice.screen_share",
    "voice.moderation",
  ]);
  if (input["runtime_capabilities"] !== undefined) {
    if (!Array.isArray(input["runtime_capabilities"])) {
      errors.push({
        code: "INVALID_RUNTIME_CAPABILITIES",
        field: "runtime_capabilities",
        message: "runtime_capabilities must be an array of strings.",
      });
    } else {
      for (let i = 0; i < input["runtime_capabilities"].length; i++) {
        const cap = input["runtime_capabilities"][i];
        if (typeof cap !== "string") {
          errors.push({
            code: "INVALID_RUNTIME_CAPABILITY",
            field: `runtime_capabilities[${i}]`,
            message: `runtime_capabilities[${i}] must be a string.`,
          });
        } else if (!VALID_RUNTIME_CAPABILITIES.has(cap)) {
          errors.push({
            code: "UNKNOWN_RUNTIME_CAPABILITY",
            field: `runtime_capabilities[${i}]`,
            message: `runtime_capabilities[${i}] ("${cap}") is not a recognized runtime capability.`,
          });
        }
      }
    }
  }

  // --- managed_services (optional array of non-empty strings) ---
  //
  // Schema-level validation only: the manifest layer cannot reach the
  // runtime managed-service registry (runtime/src/managed-services/registry.ts).
  // The presence-in-registry check lives in the resolver
  // (runtime/src/resolver.ts) so it can consult the registry the runtime
  // build exposes. This validator only catches malformed shapes; values
  // unknown to the runtime registry (e.g. anything other than "livekit"
  // in the current build) are rejected at resolve time, not here.
  if (input["managed_services"] !== undefined) {
    if (!Array.isArray(input["managed_services"])) {
      errors.push({
        code: "INVALID_MANAGED_SERVICES",
        field: "managed_services",
        message: "managed_services must be an array of strings.",
      });
    } else {
      for (let i = 0; i < input["managed_services"].length; i++) {
        const svc = input["managed_services"][i];
        if (typeof svc !== "string" || svc.length === 0) {
          errors.push({
            code: "INVALID_MANAGED_SERVICE",
            field: `managed_services[${i}]`,
            message: `managed_services[${i}] must be a non-empty string.`,
          });
        }
      }
    }
  }

  // --- icon (optional string, ≤64 chars) ---
  if (input["icon"] !== undefined) {
    if (typeof input["icon"] !== "string" || input["icon"].length === 0) {
      errors.push({
        code: "INVALID_ICON",
        field: "icon",
        message: "icon must be a non-empty string if provided.",
      });
    } else if (input["icon"].length > 64) {
      errors.push({
        code: "INVALID_ICON",
        field: "icon",
        message: "icon must be at most 64 characters.",
      });
    }
  }

  // --- serve_ready_handshake (optional boolean) ---
  if (
    input["serve_ready_handshake"] !== undefined &&
    typeof input["serve_ready_handshake"] !== "boolean"
  ) {
    errors.push({
      code: "INVALID_SERVE_READY_HANDSHAKE",
      field: "serve_ready_handshake",
      message: "serve_ready_handshake must be a boolean if provided.",
    });
  }

  // --- client_capabilities (optional array of strings) ---
  const VALID_CLIENT_CAPABILITIES = new Set(["client.browser"]);
  if (input["client_capabilities"] !== undefined) {
    if (!Array.isArray(input["client_capabilities"])) {
      errors.push({
        code: "INVALID_CLIENT_CAPABILITIES",
        field: "client_capabilities",
        message: "client_capabilities must be an array of strings.",
      });
    } else {
      for (let i = 0; i < input["client_capabilities"].length; i++) {
        const cap = input["client_capabilities"][i];
        if (typeof cap !== "string") {
          errors.push({
            code: "INVALID_CLIENT_CAPABILITY",
            field: `client_capabilities[${i}]`,
            message: `client_capabilities[${i}] must be a string.`,
          });
        } else if (!VALID_CLIENT_CAPABILITIES.has(cap)) {
          errors.push({
            code: "UNKNOWN_CLIENT_CAPABILITY",
            field: `client_capabilities[${i}]`,
            message: `client_capabilities[${i}] ("${cap}") is not a recognized client capability. Valid values: ${[...VALID_CLIENT_CAPABILITIES].join(", ")}.`,
          });
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Build the validated manifest
  const manifest: PluginManifest = {
    name: input["name"] as string,
    version: input["version"] as string,
    api_version: input["api_version"] as string,
    author: input["author"] as string,
    description: input["description"] as string,
    type: input["type"] as PluginType,
    permissions: input["permissions"] as string[],
  };

  if (typeof input["license"] === "string") manifest.license = input["license"];
  if (input["extends"] !== undefined) manifest.extends = input["extends"] as string;
  if (typeof input["icon"] === "string") manifest.icon = input["icon"];
  if (input["backend"] !== undefined)
    manifest.backend = input["backend"] as ManifestBackend;
  if (input["frontend"] !== undefined)
    manifest.frontend = input["frontend"] as ManifestFrontend;
  if (input["public_schema"] !== undefined)
    manifest.public_schema = input["public_schema"] as Record<string, PublicSchemaTable>;
  if (input["dependencies"] !== undefined)
    manifest.dependencies = input["dependencies"] as Record<string, string>;
  if (input["resources"] !== undefined)
    manifest.resources = input["resources"] as ManifestResources;
  if (input["sidebar"] !== undefined) {
    const sb = input["sidebar"] as Record<string, unknown>;
    const sidebar: ManifestSidebar = { contributes: sb["contributes"] as boolean };
    if (Array.isArray(sb["refresh_on"])) sidebar.refresh_on = sb["refresh_on"] as string[];
    if (typeof sb["section"] === "string") sidebar.section = sb["section"];
    manifest.sidebar = sidebar;
  }
  if (Array.isArray(input["settings"])) {
    manifest.settings = input["settings"] as PluginSetting[];
  }
  // (No extra parsing here — settings is already typed PluginSetting[];
  //  optional fields like `stops` ride along when present.)
  if (Array.isArray(input["client_capabilities"])) {
    manifest.client_capabilities = input["client_capabilities"] as string[];
  }
  if (Array.isArray(input["runtime_capabilities"])) {
    manifest.runtime_capabilities = input["runtime_capabilities"] as string[];
  }
  if (Array.isArray(input["managed_services"])) {
    manifest.managed_services = input["managed_services"] as string[];
  }
  if (typeof input["serve_ready_handshake"] === "boolean") {
    manifest.serve_ready_handshake = input["serve_ready_handshake"];
  }
  if (Array.isArray(input["proxy_mounts"])) {
    manifest.proxy_mounts = input["proxy_mounts"] as ProxyMount[];
  }

  return { ok: true, manifest };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function validateRequiredString(
  obj: Record<string, unknown>,
  field: string,
  errors: ManifestError[],
): void {
  const val = obj[field];
  if (val === undefined || val === null) {
    errors.push({
      code: "MISSING_FIELD",
      field,
      message: `${field} is required.`,
    });
  } else if (typeof val !== "string") {
    errors.push({
      code: "INVALID_TYPE",
      field,
      message: `${field} must be a string.`,
    });
  } else if (val.length === 0) {
    errors.push({
      code: "EMPTY_FIELD",
      field,
      message: `${field} must not be empty.`,
    });
  }
}

function validatePositiveInt(
  obj: Record<string, unknown>,
  key: string,
  field: string,
  errors: ManifestError[],
): void {
  if (obj[key] === undefined) return;
  const val = obj[key];
  if (typeof val !== "number" || !Number.isInteger(val) || val <= 0) {
    errors.push({
      code: "INVALID_RESOURCE",
      field,
      message: `${field} must be a positive integer.`,
    });
  }
}
