// Runtime → plugin contract version. Distinct from the runtime's *release*
// version (RUNTIME_VERSION, surfaced by /health and heartbeat). Bump this only
// when the plugin SDK surface changes; release versions iterate freely without
// affecting plugin compatibility.
//
// Plugins declare a semver range in manifest.json (`api_version`) that
// satisfiesRange(PLUGIN_API_VERSION, manifest.api_version) → load. The same
// concrete version is forwarded to plugin subprocesses as
// `PLUGIN_API_VERSION` so they can branch on the host they're talking to.
//
// Reserved bumps: 1.x stays additive; jump to 2.0.0 only for breaking IPC
// or capability changes. See spec-04 §"Compatibility rules".

export const PLUGIN_API_VERSION = "1.0.0";
