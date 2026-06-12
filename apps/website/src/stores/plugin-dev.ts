import { createSignal } from "solid-js";
import type {
  AgentDetection,
  CreateDevPluginInput,
  CreateDevPluginResult,
  DevPlugin,
  DevPluginDeployProgress,
  DevPluginInstallTarget,
  InstallDevPluginOptions,
  InstallDevPluginResult,
  LaunchAgentResult,
  UninstallDevPluginResult,
} from "@uncorded/electron-bridge";
import { isElectron, getElectron } from "@/lib/electron";
import { showToast } from "@/lib/feedback";

// Renderer-side cache + actions for the Plugin Development Workspace.
// Desktop main is the source of truth (~/.uncorded/plugin-dev/<slug>/ — the
// folders ARE the registry); this store mirrors the list so the sheet renders
// synchronously. Machine-GLOBAL, not per-server. Electron-only — every entry
// point early-returns under a plain web build.

const [devPlugins, setDevPlugins] = createSignal<DevPlugin[]>([]);
const [agentDetection, setAgentDetection] = createSignal<AgentDetection>({ found: false });

export { devPlugins, agentDetection };

/** Fetch (or refetch) the workspace list. No-op on web. */
export async function loadDevPlugins(): Promise<void> {
  if (!isElectron()) return;
  try {
    setDevPlugins(await getElectron().pluginDev.list());
  } catch (err) {
    console.error("[plugin-dev] list failed", { err });
  }
}

/** Probe for the claude CLI. Called on sheet open (PATH can change between
 *  app launches; a per-open probe is cheap and stays fresh). */
export async function detectAgent(): Promise<void> {
  if (!isElectron()) return;
  try {
    setAgentDetection(await getElectron().pluginDev.detectAgent());
  } catch (err) {
    console.error("[plugin-dev] detect-agent failed", { err });
    setAgentDetection({ found: false });
  }
}

/**
 * Scaffold a new dev plugin. Returns the typed result so the dialog can render
 * slug errors inline; transport-level failures surface as WRITE_FAILED-shaped
 * results rather than throws so the dialog has one error path.
 */
export async function createDevPlugin(
  input: CreateDevPluginInput,
): Promise<CreateDevPluginResult> {
  if (!isElectron()) {
    return { ok: false, code: "WRITE_FAILED", message: "Plugin Dev requires the desktop app." };
  }
  try {
    const result = await getElectron().pluginDev.create(input);
    if (result.ok) {
      setDevPlugins((list) => [...list, result.plugin]);
    }
    return result;
  } catch (err) {
    console.error("[plugin-dev] create failed", { err });
    const message = err instanceof Error ? err.message : "Could not create the plugin.";
    return { ok: false, code: "WRITE_FAILED", message };
  }
}

/** Move a dev plugin to the OS trash and drop it from the cache. */
export async function removeDevPlugin(slug: string): Promise<void> {
  if (!isElectron()) return;
  try {
    const removed = await getElectron().pluginDev.remove(slug);
    if (removed) {
      setDevPlugins((list) => list.filter((p) => p.slug !== slug));
      showToast("Moved to Recycle Bin", "info");
    } else {
      // The folder vanished out-of-band — resync rather than pretend.
      await loadDevPlugins();
    }
  } catch (err) {
    console.error("[plugin-dev] remove failed", { slug, err });
    showToast("Could not delete the plugin folder", "error");
  }
}

/** Reveal the plugin folder in the OS file manager. */
export async function openDevPluginFolder(slug: string): Promise<void> {
  if (!isElectron()) return;
  try {
    await getElectron().pluginDev.openFolder(slug);
  } catch (err) {
    console.error("[plugin-dev] open-folder failed", { slug, err });
    showToast("Could not open the plugin folder", "error");
  }
}

/** Regenerate + copy the agent prompt. Returns whether the copy happened. */
export async function copyDevPluginPrompt(slug: string): Promise<boolean> {
  if (!isElectron()) return false;
  try {
    await getElectron().pluginDev.copyPrompt(slug);
    showToast("Agent prompt copied to clipboard", "info");
    return true;
  } catch (err) {
    console.error("[plugin-dev] copy-prompt failed", { slug, err });
    showToast("Could not copy the prompt", "error");
    return false;
  }
}

/**
 * Open a terminal running the agent in the plugin folder. Main copies the
 * prompt to the clipboard first, so every failure path here ends with the
 * same honest fallback toast.
 */
export async function launchDevPluginAgent(slug: string): Promise<LaunchAgentResult> {
  if (!isElectron()) {
    return { ok: false, code: "SPAWN_FAILED", message: "Requires the desktop app." };
  }
  try {
    const result = await getElectron().pluginDev.launchAgent(slug);
    if (result.ok) {
      showToast("Agent started in the plugin folder", "info");
    } else if (result.code === "NO_TERMINAL" || result.code === "SPAWN_FAILED") {
      showToast("Prompt copied — open the folder and run `claude` yourself", "info");
    } else if (result.code === "AGENT_NOT_FOUND") {
      showToast("claude CLI not found — prompt copied to clipboard instead", "info");
    }
    return result;
  } catch (err) {
    console.error("[plugin-dev] launch-agent failed", { slug, err });
    showToast("Prompt copied — open the folder and run `claude` yourself", "info");
    return { ok: false, code: "SPAWN_FAILED", message: "launch failed" };
  }
}

/** Locally-hosted servers this plugin could be installed into. */
export async function listInstallTargets(slug: string): Promise<DevPluginInstallTarget[]> {
  if (!isElectron()) return [];
  try {
    return await getElectron().pluginDev.listInstallTargets(slug);
  } catch (err) {
    console.error("[plugin-dev] list-targets failed", { slug, err });
    return [];
  }
}

/** Install (or redeploy) into a server. Restarts that server. */
export async function installDevPluginIntoServer(
  slug: string,
  serverId: string,
  options?: InstallDevPluginOptions,
): Promise<InstallDevPluginResult> {
  if (!isElectron()) {
    return { ok: false, code: "NOT_IMPLEMENTED", message: "Requires the desktop app." };
  }
  try {
    return await getElectron().pluginDev.installIntoServer(slug, serverId, options);
  } catch (err) {
    console.error("[plugin-dev] install failed", { slug, serverId, err });
    const message = err instanceof Error ? err.message : "Install failed.";
    return { ok: false, code: "INSTALL_FAILED", message };
  }
}

/** Remove the plugin from a server (its data stays unless deleteData). */
export async function uninstallDevPluginFromServer(
  slug: string,
  serverId: string,
  deleteData: boolean,
): Promise<UninstallDevPluginResult> {
  if (!isElectron()) {
    return { ok: false, code: "UNINSTALL_FAILED", message: "Requires the desktop app." };
  }
  try {
    return await getElectron().pluginDev.uninstallFromServer(slug, serverId, deleteData);
  } catch (err) {
    console.error("[plugin-dev] uninstall failed", { slug, serverId, err });
    const message = err instanceof Error ? err.message : "Uninstall failed.";
    return { ok: false, code: "UNINSTALL_FAILED", message };
  }
}

/** Subscribe to deploy/undeploy step events. Returns an unsubscribe fn. */
export function onDevPluginDeployProgress(
  cb: (event: DevPluginDeployProgress) => void,
): () => void {
  if (!isElectron()) return () => {};
  return getElectron().pluginDev.onDeployProgress(cb);
}
