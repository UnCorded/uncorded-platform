// Plugin resolver — steps 1-2 of the 7-step loading sequence.
// Locates plugin folders, validates manifests, resolves dependencies,
// and returns a topologically sorted load order.

import {
  validateManifest,
  satisfiesRange,
} from "@uncorded/shared";
import type { PluginManifest, ManifestError } from "@uncorded/shared";
import { isRegisteredService, listRegisteredServices } from "./managed-services/registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolverError {
  code: string;
  plugin: string;
  message: string;
  details?: ManifestError[];
}

export interface ResolvedPlugin {
  slug: string;
  path: string;
  manifest: PluginManifest;
}

export type ResolverResult =
  | { ok: true; plugins: ResolvedPlugin[] }
  | { ok: false; errors: ResolverError[] };

/**
 * Filesystem abstraction for reading manifest files.
 * Returns the parsed JSON content, or throws if the file doesn't exist or can't be read.
 *
 * Throwing conventions:
 * - Throw with `{ code: "ENOENT" }` if the file does not exist.
 * - Throw with any other error if the file can't be read or parsed.
 */
export type ManifestReader = (manifestPath: string) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export async function resolvePlugins(
  pluginsDir: string,
  installedPlugins: string[],
  readManifest: ManifestReader,
  runtimeApiVersion?: string,
): Promise<ResolverResult> {
  const errors: ResolverError[] = [];
  const validated = new Map<string, { manifest: PluginManifest; path: string }>();

  // Step 1: Locate & validate each plugin
  for (const slug of installedPlugins) {
    // Reserved slugs collide with built-in runtime routing (handleCoreClientAction,
    // /admin/*). A plugin with slug "core" or "admin" would shadow the built-in
    // handlers and its WS/HTTP traffic would silently never reach the subprocess.
    // Fail loud rather than risk a deployment that appears to work.
    if (slug === "core" || slug === "admin") {
      errors.push({
        code: "RESERVED_SLUG",
        plugin: slug,
        message: `${slug}: "${slug}" is reserved for built-in runtime features and cannot be used as a plugin slug.`,
      });
      continue;
    }

    const pluginPath = `${pluginsDir}/${slug}`;
    const manifestPath = `${pluginPath}/manifest.json`;

    // Read manifest from disk
    let raw: unknown;
    try {
      raw = await readManifest(manifestPath);
    } catch (err: unknown) {
      const errObj = err as Record<string, unknown> | null;
      if (errObj && errObj["code"] === "ENOENT") {
        errors.push({
          code: "MANIFEST_NOT_FOUND",
          plugin: slug,
          message: `${slug}: manifest.json not found at ${manifestPath}.`,
        });
      } else {
        const detail = errObj && typeof errObj["message"] === "string"
          ? errObj["message"]
          : "Unknown read error";
        errors.push({
          code: "MANIFEST_READ_FAILED",
          plugin: slug,
          message: `${slug}: failed to read manifest.json — ${detail}.`,
        });
      }
      continue;
    }

    // Validate manifest schema
    const result = validateManifest(raw);
    if (!result.ok) {
      errors.push({
        code: "MANIFEST_INVALID",
        plugin: slug,
        message: `${slug}: manifest.json failed validation with ${result.errors.length} error(s).`,
        details: result.errors,
      });
      continue;
    }

    // Verify slug matches manifest name
    if (result.manifest.name !== slug) {
      errors.push({
        code: "SLUG_MISMATCH",
        plugin: slug,
        message: `${slug}: folder name "${slug}" does not match manifest name "${result.manifest.name}".`,
      });
      continue;
    }

    // Check API version compatibility with the runtime
    if (runtimeApiVersion !== undefined) {
      if (!satisfiesRange(runtimeApiVersion, result.manifest.api_version)) {
        errors.push({
          code: "INCOMPATIBLE_API_VERSION",
          plugin: slug,
          message: `${slug}: requires api_version ${result.manifest.api_version} but runtime is ${runtimeApiVersion}.`,
        });
        continue;
      }
    }

    // Managed services declared in the manifest must be registered with the
    // runtime's static service registry. Install-time check only — the
    // resolver does not spawn services or call claim/release. Unknown
    // values reject; the registry is populated at module init by concrete
    // supervisors (e.g. "livekit" via runtime/src/voice/register.ts).
    if (result.manifest.managed_services && result.manifest.managed_services.length > 0) {
      const unknown = result.manifest.managed_services.filter((svc) => !isRegisteredService(svc));
      if (unknown.length > 0) {
        const known = listRegisteredServices();
        const knownDesc = known.length === 0 ? "(none)" : known.join(", ");
        errors.push({
          code: "UNKNOWN_MANAGED_SERVICE",
          plugin: slug,
          message: `${slug}: managed_services references unregistered service(s) [${unknown.join(", ")}]. Known: ${knownDesc}.`,
        });
        continue;
      }
    }

    validated.set(slug, { manifest: result.manifest, path: pluginPath });
  }

  // If any step-1 errors, bail before dependency resolution
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Step 2: Check dependencies and build adjacency
  const adjacency = new Map<string, string[]>(); // slug → slugs it depends on
  for (const slug of validated.keys()) {
    adjacency.set(slug, []);
  }

  for (const [slug, { manifest }] of validated) {
    const deps = adjacency.get(slug)!;

    // Check declared dependencies
    if (manifest.dependencies) {
      for (const [depSlug, depRange] of Object.entries(manifest.dependencies)) {
        const dep = validated.get(depSlug);
        if (!dep) {
          errors.push({
            code: "MISSING_DEPENDENCY",
            plugin: slug,
            message: `${slug}: depends on "${depSlug}" which is not installed.`,
          });
          continue;
        }

        if (!satisfiesRange(dep.manifest.version, depRange)) {
          errors.push({
            code: "INCOMPATIBLE_DEPENDENCY",
            plugin: slug,
            message: `${slug}: depends on "${depSlug}" ${depRange} but found version ${dep.manifest.version}.`,
          });
          continue;
        }

        deps.push(depSlug);
      }
    }

    // Check extension base plugin
    if (manifest.type === "extension" && manifest.extends) {
      const base = validated.get(manifest.extends);
      if (!base) {
        errors.push({
          code: "MISSING_BASE_PLUGIN",
          plugin: slug,
          message: `${slug}: extends "${manifest.extends}" which is not installed.`,
        });
      } else {
        // Avoid duplicate edge if extends target is also in dependencies
        if (!deps.includes(manifest.extends)) {
          deps.push(manifest.extends);
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Step 3: Topological sort (Kahn's algorithm)
  const sorted = topologicalSort(adjacency);
  if (!sorted.ok) {
    // Report cycle — name the plugins involved
    return {
      ok: false,
      errors: [
        {
          code: "CIRCULAR_DEPENDENCY",
          plugin: sorted.cycle[0] ?? "unknown",
          message: `Circular dependency detected among: ${sorted.cycle.join(" → ")}.`,
        },
      ],
    };
  }

  const plugins: ResolvedPlugin[] = sorted.order.map((slug) => {
    const entry = validated.get(slug)!;
    return { slug, path: entry.path, manifest: entry.manifest };
  });

  return { ok: true, plugins };
}

// ---------------------------------------------------------------------------
// Topological sort
// ---------------------------------------------------------------------------

type TopoResult =
  | { ok: true; order: string[] }
  | { ok: false; cycle: string[] };

function topologicalSort(adjacency: Map<string, string[]>): TopoResult {
  // adjacency: slug → [deps it depends ON]
  // in-degree = number of dependencies a node has
  // Nodes with 0 in-degree = no dependencies = can load first
  const inDegree = new Map<string, number>();
  const reverseDeps = new Map<string, string[]>(); // dep → [slugs that depend on dep]

  for (const slug of adjacency.keys()) {
    inDegree.set(slug, adjacency.get(slug)!.length);
    reverseDeps.set(slug, []);
  }

  for (const [slug, deps] of adjacency) {
    for (const dep of deps) {
      reverseDeps.get(dep)!.push(slug);
    }
  }

  // Kahn's: start with nodes that have 0 in-degree (no dependencies)
  const queue: string[] = [];
  for (const [slug, degree] of inDegree) {
    if (degree === 0) {
      queue.push(slug);
    }
  }

  const order: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);

    // For each node that depends on current, decrement its in-degree
    for (const dependent of reverseDeps.get(current)!) {
      const newDegree = inDegree.get(dependent)! - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) {
        queue.push(dependent);
      }
    }
  }

  if (order.length !== adjacency.size) {
    // Cycle detected — find the remaining nodes
    const remaining = [...adjacency.keys()].filter((s) => !order.includes(s));
    return { ok: false, cycle: remaining };
  }

  return { ok: true, order };
}
