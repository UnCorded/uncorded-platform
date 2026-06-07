// Static registry mapping service slug → supervisor factory.
//
// Concrete supervisors register themselves at module init (e.g.
// runtime/src/voice/register.ts calls `registerSupervisor("livekit",
// LiveKitSupervisorFactory)`). Registration must happen before plugin
// manifest validation runs at boot, otherwise valid plugins will be
// rejected for declaring services the registry hasn't been told about yet.
//
// Registration is process-global on purpose: the static registry is the
// single source of truth that the manifest validator and the plugin
// loader both consult. We don't want a per-runtime injection because
// then "is livekit a real service?" becomes ambient state instead
// of a property of the runtime build.
//
// Trust boundary: `registerSupervisor` is callable only from
// runtime/src/** — never from plugin code. Managed services are a
// property of the runtime build, like a kernel module; plugins consume
// services by declaring them in manifests, they do not provide them.
// Do not expose a re-export of this function through any plugin SDK
// surface.
//
// Tests must call `__resetRegistryForTests()` between cases to avoid
// leakage when registering mock factories.

import type { ManagedServiceSupervisor, ServiceSlug, SupervisorFactory } from "./types";

const factories = new Map<ServiceSlug, SupervisorFactory>();
const instances = new Map<ServiceSlug, ManagedServiceSupervisor>();

/** Register a supervisor factory. Re-registering throws — the registry is
 *  static; if you need to change a factory, restart the process. */
export function registerSupervisor(slug: ServiceSlug, factory: SupervisorFactory): void {
  if (factories.has(slug)) {
    throw new Error(`Managed service "${slug}" is already registered.`);
  }
  factories.set(slug, factory);
}

/** True iff the slug maps to a registered supervisor factory. The
 *  manifest validator uses this to gate `managed_services` values. */
export function isRegisteredService(slug: string): boolean {
  return factories.has(slug);
}

/** All registered service slugs (sorted for deterministic listing). */
export function listRegisteredServices(): ServiceSlug[] {
  return [...factories.keys()].sort();
}

/**
 * Get-or-create the supervisor instance for a service. Plugin loader
 * (PR-3+) calls this to obtain a supervisor and `claim()` against it.
 * Returns undefined for unknown slugs — callers should pre-validate via
 * `isRegisteredService`.
 */
export function getSupervisor(slug: ServiceSlug): ManagedServiceSupervisor | undefined {
  let instance = instances.get(slug);
  if (instance) return instance;
  const factory = factories.get(slug);
  if (!factory) return undefined;
  instance = factory(slug);
  instances.set(slug, instance);
  return instance;
}

/** Test-only reset hook. Clears both factories and instances so each
 *  test case starts from a clean registry. Calling from production code
 *  is a bug — the static-registry contract relies on stable state. The
 *  NODE_ENV guard makes the bug loud rather than silent if some future
 *  code path tries to invoke this at runtime. */
export function __resetRegistryForTests(): void {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("__resetRegistryForTests is test-only and must not be called in production.");
  }
  factories.clear();
  instances.clear();
}
