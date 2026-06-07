// SDK API version — bumped whenever the §3/§4 envelope or request contract
// gains new shapes. The iframe ships this in the `uncorded.ready` payload so
// the shell can detect cached/stale plugin bundles and force a reload of both
// the iframe HTML and `/sdk/plugin-frontend.js` (memory: feedback_sdk_bundle_cache.md
// — the two cache lifetimes must be coupled).
//
// Bump rules:
//   - PATCH  (1.0.0 → 1.0.1) — never; the SDK doesn't ship patch granularity.
//   - MINOR  (1.0 → 1.1)     — additive: new envelopes, new request types,
//                              new optional fields. Existing plugins keep working.
//   - MAJOR  (1.x → 2.0)     — breaking changes to existing shapes. Expect a
//                              coordinated runtime + manifest bump.
//
// Manifests declare a semver range (e.g. `^1.0`); the runtime resolver compares
// against this constant. Plugin frontends declare their loaded SDK version on
// `uncorded.ready` so the shell can bust caches when the iframe HTML and the
// SDK bundle drift apart.
export const SDK_API_VERSION = "1.1";
