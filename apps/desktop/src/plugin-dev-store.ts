// Local, desktop-owned store for the Plugin Development Workspace — the
// persistent home for user-authored plugins, independent of any server
// (plugins copied into a server volume die with the server; these don't).
//
// Layout: ~/.uncorded/plugin-dev/<slug>/ — one folder per plugin, the folder
// IS the registry (directory-scan-as-truth). No central index file: users and
// coding agents rename/delete/copy these folders out-of-band constantly, and
// a folder rescued from a backup should simply appear. Per-plugin metadata
// that can't be derived from the folder (the creation idea, scaffold version)
// lives in a `.uncorded-dev.json` sidecar inside the folder; a corrupt or
// missing sidecar degrades gracefully (folder name + mtime), never blocks.
//
// The manifest is read tolerantly here (JSON.parse + typeof picks, NOT
// validateManifest) for two reasons: agents edit these files live so invalid
// is a state to display, and desktop main can't runtime-import the raw-TS
// @uncorded/shared package anyway (tests pin the duplicated slug grammar).

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CreateDevPluginErrorCode,
  CreateDevPluginInput,
  DevPlugin,
  DevPluginManifestStatus,
} from "@uncorded/electron-bridge";
import {
  PLUGIN_DEV_SLUG_RE,
  SCAFFOLD_VERSION,
  scaffoldPluginFiles,
  validateDevPluginSlug,
} from "./plugin-dev-templates";
import { buildAgentPrompt } from "./plugin-dev-prompt";

export type { DevPlugin };

const SIDECAR_NAME = ".uncorded-dev.json";
const PROMPT_NAME = "PROMPT.md";

interface DevPluginSidecar {
  schemaVersion: 1;
  displayName: string;
  description: string;
  idea: string;
  createdAt: number;
  scaffoldVersion: number;
}

/** Internal create result — main maps this onto the bridge's
 *  CreateDevPluginResult after handling the clipboard side effect. */
export type CreateDevPluginStoreResult =
  | { ok: true; plugin: DevPlugin; prompt: string }
  | { ok: false; code: CreateDevPluginErrorCode; message: string };

export function pluginDevRoot(): string {
  return join(homedir(), ".uncorded", "plugin-dev");
}

/**
 * Resolve a slug to its workspace folder. Returns null unless the slug is
 * grammar-valid AND the folder exists — the single path-traversal guard every
 * slug-taking IPC handler funnels through before touching fs/shell.
 */
export function devPluginPath(slug: string): string | null {
  if (!PLUGIN_DEV_SLUG_RE.test(slug)) return null;
  const p = join(pluginDevRoot(), slug);
  if (!existsSync(p)) return null;
  return p;
}

function readSidecar(pluginDir: string): DevPluginSidecar | null {
  const p = join(pluginDir, SIDECAR_NAME);
  if (!existsSync(p)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (
    o["schemaVersion"] !== 1 ||
    typeof o["displayName"] !== "string" ||
    typeof o["description"] !== "string" ||
    typeof o["idea"] !== "string" ||
    typeof o["createdAt"] !== "number" ||
    typeof o["scaffoldVersion"] !== "number"
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    displayName: o["displayName"],
    description: o["description"],
    idea: o["idea"],
    createdAt: o["createdAt"],
    scaffoldVersion: o["scaffoldVersion"],
  };
}

interface ManifestPeek {
  status: DevPluginManifestStatus;
  description?: string;
}

function peekManifest(pluginDir: string): ManifestPeek {
  const p = join(pluginDir, "manifest.json");
  if (!existsSync(p)) return { status: "missing" };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { status: "invalid" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { status: "invalid" };
  }
  const o = raw as Record<string, unknown>;
  const description = typeof o["description"] === "string" ? o["description"] : undefined;
  return { status: "ok", ...(description !== undefined ? { description } : {}) };
}

function toDevPlugin(slug: string, pluginDir: string): DevPlugin {
  const sidecar = readSidecar(pluginDir);
  const manifest = peekManifest(pluginDir);
  let createdAt = sidecar?.createdAt;
  if (createdAt === undefined) {
    try {
      createdAt = statSync(pluginDir).mtimeMs;
    } catch {
      createdAt = 0;
    }
  }
  return {
    slug,
    displayName: sidecar?.displayName ?? slug,
    // Prefer the live manifest description — the agent evolves it; the
    // sidecar keeps the creation-time text as fallback.
    description: manifest.description ?? sidecar?.description ?? "",
    path: pluginDir,
    createdAt,
    scaffoldVersion: sidecar?.scaffoldVersion ?? null,
    manifestStatus: manifest.status,
  };
}

/** Scan the workspace. Only slug-shaped directory names count; anything else
 *  (loose files, .staging dirs, OS droppings) is ignored. */
export function listDevPlugins(): DevPlugin[] {
  const root = pluginDevRoot();
  if (!existsSync(root)) return [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (err) {
    console.error("[plugin-dev] workspace scan failed", { err });
    return [];
  }
  const plugins: DevPlugin[] = [];
  for (const name of names) {
    if (!PLUGIN_DEV_SLUG_RE.test(name)) continue;
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    plugins.push(toDevPlugin(name, dir));
  }
  // Stable ordering: oldest first, same discipline as the Web Apps sidebar.
  return plugins.sort((a, b) => a.createdAt - b.createdAt);
}

export function createDevPlugin(input: CreateDevPluginInput): CreateDevPluginStoreResult {
  const slugCheck = validateDevPluginSlug(input.slug);
  if (!slugCheck.ok) return slugCheck;
  if (input.pluginType === "extension") {
    const base = input.extendsSlug ?? "";
    if (!PLUGIN_DEV_SLUG_RE.test(base)) {
      return {
        ok: false,
        code: "SLUG_INVALID",
        message: "An extension plugin must name a valid base-plugin slug to extend.",
      };
    }
  }

  const dir = join(pluginDevRoot(), input.slug);
  if (existsSync(dir)) {
    return {
      ok: false,
      code: "SLUG_TAKEN",
      message: `A dev plugin named "${input.slug}" already exists in the workspace.`,
    };
  }

  const files = scaffoldPluginFiles({
    slug: input.slug,
    displayName: input.displayName,
    description: input.description,
    author: input.author,
    pluginType: input.pluginType,
    ...(input.extendsSlug !== undefined ? { extendsSlug: input.extendsSlug } : {}),
    ...(input.icon !== undefined ? { icon: input.icon } : {}),
  });
  const prompt = buildAgentPrompt({
    slug: input.slug,
    displayName: input.displayName,
    description: input.description,
    idea: input.idea,
    pluginPath: dir,
  });
  const sidecar: DevPluginSidecar = {
    schemaVersion: 1,
    displayName: input.displayName,
    description: input.description,
    idea: input.idea,
    createdAt: Date.now(),
    scaffoldVersion: SCAFFOLD_VERSION,
  };

  try {
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      const target = join(dir, file.relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, "utf8");
    }
    writeFileSync(join(dir, PROMPT_NAME), prompt, "utf8");
    writeFileSync(join(dir, SIDECAR_NAME), JSON.stringify(sidecar, null, 2) + "\n", "utf8");
  } catch (err) {
    // The folder didn't exist before this call (checked above), so a partial
    // scaffold is safe to remove — never leave a half-plugin that lists as real.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort; the lister tolerates whatever remains.
    }
    console.error("[plugin-dev] scaffold write failed", { slug: input.slug, err });
    return {
      ok: false,
      code: "WRITE_FAILED",
      message: "Could not write the plugin folder. Check disk space and permissions.",
    };
  }

  return { ok: true, plugin: toDevPlugin(input.slug, dir), prompt };
}

/**
 * Rebuild the agent prompt from the sidecar's creation idea plus the live
 * manifest description, rewrite PROMPT.md, and return the prompt (the caller
 * copies it to the clipboard). Null when the slug doesn't resolve.
 */
export function regenerateDevPrompt(slug: string): string | null {
  const dir = devPluginPath(slug);
  if (dir === null) return null;
  const sidecar = readSidecar(dir);
  const manifest = peekManifest(dir);
  const prompt = buildAgentPrompt({
    slug,
    displayName: sidecar?.displayName ?? slug,
    description: manifest.description ?? sidecar?.description ?? "",
    idea: sidecar?.idea ?? "(original idea unavailable — see README.md and the code)",
    pluginPath: dir,
  });
  try {
    writeFileSync(join(dir, PROMPT_NAME), prompt, "utf8");
  } catch (err) {
    // Clipboard copy still works without the on-disk refresh.
    console.warn("[plugin-dev] PROMPT.md rewrite failed", { slug, err });
  }
  return prompt;
}

/**
 * Move a dev plugin to the OS trash — recoverable by design; this feature
 * exists because users lost plugins to hard deletes. The trash function is
 * injected (main passes Electron's shell.trashItem) so tests stay off the
 * shared electron stub. Returns false when the slug doesn't resolve.
 */
export async function deleteDevPlugin(
  slug: string,
  trash: (path: string) => Promise<void>,
): Promise<boolean> {
  const dir = devPluginPath(slug);
  if (dir === null) return false;
  await trash(dir);
  return true;
}
