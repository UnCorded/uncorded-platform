# Manifest reference

`manifest.json` is the contract between a plugin and the runtime. It is validated
at load against [`packages/shared/src/manifest.ts`](https://github.com/UnCorded/uncorded-platform/blob/main/packages/shared/src/manifest.ts);
an invalid manifest means the plugin is skipped. Unknown top-level fields are
**rejected** (typo protection), so the table below is the complete allowed set.

## Minimal example

```json
{
  "name": "guestbook",
  "version": "0.1.0",
  "api_version": "^1.0",
  "author": "you",
  "description": "A simple server guestbook.",
  "type": "standalone",
  "backend": { "entry": "backend/index.ts" },
  "frontend": { "entry": "frontend/index.html" },
  "permissions": ["data.sql:self", "broadcast.clients"]
}
```

## Top-level fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | ✅ | Slug. Must match `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` — lowercase, starts with a letter, no leading/trailing/consecutive hyphens. This is the plugin's identity everywhere. |
| `version` | string | ✅ | Strict semver `MAJOR.MINOR.PATCH`. No pre-release/build metadata. |
| `api_version` | string | ✅ | Runtime-API compatibility range, e.g. `^1.0`. |
| `author` | string | ✅ | Non-empty. |
| `description` | string | ✅ | Non-empty. |
| `type` | `"core"` \| `"standalone"` \| `"extension"` | ✅ | See [Plugin type](#plugin-type-extends). |
| `permissions` | string[] | ✅ | Capability strings the runtime will allow. May be empty for a frontend-only plugin. See [Permissions](/reference/permissions). |
| `extends` | string | conditional | **Required** iff `type: "extension"`; forbidden otherwise. The base plugin's slug. |
| `backend` | `{ entry: string }` | conditional | Backend entry path. At least one of `backend`/`frontend` required. |
| `frontend` | `{ entry: string }` | conditional | Frontend entry path (HTML). |
| `license` | string | optional | e.g. `"MIT"`. |
| `icon` | string | optional | lucide-icon name (e.g. `"Hash"`). Max 64 chars. Unknown names render a placeholder. |
| `settings` | `PluginSetting[]` | optional | Admin-configurable settings. See [Settings](#settings). |
| `sidebar` | object | optional | Sidebar contribution. See [Sidebar](#sidebar). |
| `public_schema` | `Record<string, { columns, description }>` | optional | Tables/columns exposed for cross-plugin reads. See [public_schema](#public_schema). |
| `dependencies` | `Record<slug, semverRange>` | optional | Other plugins this one depends on. |
| `resources` | `{ memory_mb?, cpu_weight?, disk_mb? }` | optional | Resource hints. Positive integers. |
| `proxy_mounts` | `ProxyMount[]` | optional | Reverse-proxy mounts. See [proxy_mounts](#proxy_mounts) and the [reverse-proxy guide](/sdk/reverse-proxy). |
| `serve_ready_handshake` | boolean | optional | Opt into the two-stage readiness handshake. See [Lifecycle](/guide/lifecycle#the-optional-serve-ready-handshake). Default `false`. |
| `client_capabilities` | string[] | optional | Client platform requirements. V1: only `"client.browser"`. |
| `runtime_capabilities` | string[] | optional | Runtime opt-ins: `"voice.media"`, `"voice.screen_share"`, `"voice.moderation"`. Unknown values rejected. |
| `managed_services` | string[] | optional | Sidecar services the runtime supervises. Recognized: `"livekit"`. |

## Plugin type & `extends`

| `type` | Meaning | `extends` |
| --- | --- | --- |
| `core` | Shipped by UnCorded (text-channels, voice-channels, members, moderation). | forbidden |
| `standalone` | Third-party plugin with its own functionality and data. | forbidden |
| `extension` | Third-party plugin that extends a base plugin. | **required** — the base plugin slug |

Most third-party plugins are `standalone`.

## Settings

Each entry in `settings[]` is rendered as a form field in Server settings and is
readable via [`plugin.settings`](/reference/backend-sdk#settings).

```json
{
  "key": "max_message_length",
  "label": "Max message length",
  "description": "Maximum characters allowed per message.",
  "type": "number",
  "default": 5000,
  "stops": [
    { "value": 2000, "label": "2k" },
    { "value": 5000, "label": "5k" },
    { "value": 0,    "label": "Unlimited" }
  ]
}
```

| Field | Type | Applies to | Notes |
| --- | --- | --- | --- |
| `key` | string | all | Unique within the plugin. Max 256 chars. |
| `label` | string | all | Shown in the admin panel. |
| `description` | string | all | Optional help text. |
| `type` | `"string"` \| `"secret"` \| `"number"` \| `"boolean"` | — | `secret` values are redacted from logs and masked in the UI. |
| `required` | boolean | all | Surfaced as a warning if unset. |
| `default` | string \| number \| boolean | all | Must match `type`. Used when unset. |
| `min` / `max` / `step` | number | `number` | Bounds and slider step (`step > 0`). |
| `stops` | `{ value, label }[]` | `number` | Stepped slider with labelled positions. Stored value is the underlying number (e.g. `0` = "unlimited"). |
| `max_length` | number | `string`/`secret` | Server-enforced length cap (positive). |
| `enum` | string[] | `string` | Renders a select; `default` must be a member. |

Cross-field validation enforces `min ≤ default ≤ max`, `default` length ≤
`max_length`, `default` ∈ `enum`, and `default` matching a `stops` value.

## Sidebar

```json
{ "sidebar": { "contributes": true, "section": "Chat", "refresh_on": ["text-channels.channel.created"] } }
```

| Field | Type | Notes |
| --- | --- | --- |
| `contributes` | boolean | Required. `true` if the plugin returns sidebar items. |
| `section` | string | Optional default group name for this plugin's items, used when an item doesn't set its own `section`. |
| `refresh_on` | string[] | Event topics that trigger a re-fetch of the plugin's sidebar items. |

The items themselves come from the backend's `sidebar.items` handler, not the
manifest. See [Plugin anatomy → reserved actions](/guide/plugin-anatomy#two-reserved-handler-actions).

## public_schema

Declares which of your tables and columns are readable by other plugins (via
their [`data.read`](/reference/backend-sdk#data) capability):

```json
{
  "public_schema": {
    "messages": {
      "columns": ["id", "channel_id", "author_id", "content", "created_at"],
      "description": "All messages across all channels."
    }
  }
}
```

Only listed columns are readable; everything else stays private.

## proxy_mounts

```json
{
  "proxy_mounts": [
    { "name": "demo", "upstream_setting": "demo_upstream_url", "access": "members" }
  ]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Slug-safe, unique within the plugin. Appears in the URL `/proxy/<slug>/<name>/*`. |
| `upstream_setting` | string | Key of a `string`/`secret` setting **in this same manifest** holding the upstream URL. The manifest never carries the URL directly. |
| `access` | `"members"` \| `"owner"` | Optional, default `"members"`. |

Declaring `proxy_mounts` requires at least one of `proxy.http:self` /
`proxy.websocket:self` in `permissions`. Mounts are disabled until an owner
approves them. Full guide: [Reverse-proxy plugins](/sdk/reverse-proxy).

## Validation rules (summary)

- At least one of `backend` / `frontend`.
- `type: "extension"` ⇒ `extends` present and a valid slug; `core`/`standalone`
  ⇒ no `extends`.
- Every `permissions` entry matches the [capability grammar](/reference/permissions#grammar).
- `proxy_mounts[].upstream_setting` references a declared `string`/`secret`
  setting; mount names unique; proxy permission present.
- Settings `default` consistent with `type`/`min`/`max`/`max_length`/`enum`/`stops`.
- `resources.*` positive integers; `icon` ≤ 64 chars; unknown top-level or
  per-setting fields rejected.

The tests in [`packages/shared/src/manifest.test.ts`](https://github.com/UnCorded/uncorded-platform/blob/main/packages/shared/src/manifest.test.ts)
are the exhaustive, executable spec.
