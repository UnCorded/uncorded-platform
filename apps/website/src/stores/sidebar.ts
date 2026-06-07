// Sidebar store — fetches plugin-contributed sidebar items from the server.
// On connect: calls GET /plugins to find contributing plugins, then requests
// sidebar.items from each via WS. Subscribes to refresh_on events so items
// update in real time (e.g. new channel created).

import { createSignal, createEffect, createMemo, onCleanup, untrack } from "solid-js";
import { activeServerId, activeServer, patchServer, adjustConnectedUsers, bumpServerIconVersion } from "./servers";
import {
  connect,
  isAuthenticated,
  onPluginMessage,
  onReconnect,
  onConnect,
  request,
} from "../lib/ws";
import { retry } from "../lib/retry";
import { bootTrace } from "../lib/boot-trace";
import type { CoreCategory, SidebarItem, SidebarAction } from "@uncorded/protocol";

// Soft-retry delays when /plugins returns 200 with an empty plugin list.
// /plugins is reachable only after the runtime has bound HTTP, which happens
// after all plugins are spawned and registered (runtime/src/main.ts step 6→7).
// Every healthy server has at least the core plugins (text-channels, members,
// moderation), so an empty 200 always means we hit the warm-up race. Total
// budget ≈ 32s — enough to cover a slow image start without giving up early.
// If the budget exhausts, the caller treats it as an error and the sidebar
// shows "Failed to load sidebar" instead of a blank panel. The
// runtime.plugin.ready WS subscription below also re-triggers loadSidebar
// when a plugin finishes its serve_ready handshake, so even if the initial
// budget is too short on a very cold start, the subscription eventually heals.
const EMPTY_PLUGINS_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 15_000] as const;

// Upper bound on waiting for the WS auth handshake to complete before firing
// sidebar.items requests. Past this, fire anyway — send() queues unauth'd
// frames and flushes once auth completes, so this is purely a "don't spam
// requests into the queue prematurely" gate.
const AUTH_WAIT_TIMEOUT_MS = 3_000;
const AUTH_WAIT_POLL_MS = 50;

export type { SidebarItem, CoreCategory };

export type SidebarSection = {
  slug: string;
  section: string;
  items: SidebarItem[];
  refreshOn: string[];
  /**
   * Section-level admin actions (e.g. "create-channel"). Plugins emit these
   * alongside sidebar.items so the create button is available even when the
   * item list is empty — without this, a fresh server with zero channels
   * would render a blank sidebar with no way to create the first one.
   */
  adminActions?: SidebarAction[];
};

type InstalledPlugin = {
  slug: string;
  name: string;
  sidebar: {
    contributes: boolean;
    section?: string;
    refresh_on?: string[];
  } | null;
  client_capabilities?: string[];
  runtime_capabilities?: string[];
  /**
   * Two-stage handshake state. Optional for forward-compat with older
   * runtimes that don't emit this field — undefined means ready (current
   * behavior). False means the plugin is still hydrating; the sidebar greys
   * out its items until a `runtime.plugin.ready` event flips it to true.
   */
  ready?: boolean;
};

const [sections, setSections] = createSignal<SidebarSection[]>([]);
const [categories, setCategories] = createSignal<CoreCategory[]>([]);
const [sidebarLoading, setSidebarLoading] = createSignal(false);
const [sidebarError, setSidebarError] = createSignal(false);

// Map from plugin slug → client_capabilities for the active server.
// Populated on each sidebar load; available for future capability checks.
const pluginCapabilities = new Map<string, string[]>();

// Map from plugin slug → runtime_capabilities for the active server. The shell
// voice manager (PR-5 §1) reads this to gate `platform.voice.connect` requests
// on `voice.media`. Trust path: the runtime serializes from PluginRegistry
// after manifest validation, so the capability set here is the validated grant
// list — the plugin process cannot widen it.
const pluginRuntimeCapabilities = new Map<string, string[]>();

export function getPluginRuntimeCapabilities(slug: string): string[] {
  return pluginRuntimeCapabilities.get(slug) ?? [];
}

// Two-stage handshake state. Populated from /plugins on each load and flipped
// on `runtime.plugin.ready` events. Missing entries are treated as ready —
// keeps current behavior for plugins that don't opt in via
// `serve_ready_handshake: true`. The `tick` signal exists solely to make
// `getPluginReady` reactive: every flip bumps the tick, components reading
// `getPluginReady(slug)` re-evaluate on the next microtask.
const pluginReadyState = new Map<string, boolean>();
const [readyTick, setReadyTick] = createSignal(0);

export function getPluginReady(slug: string): boolean {
  readyTick();
  return pluginReadyState.get(slug) !== false;
}

// Per-serverId capability-load gate. Workspace restore mounts plugin iframes
// the moment activeServerId flips (App.tsx setPanelContents), but the sidebar
// store's loadSidebar — which is what populates pluginRuntimeCapabilities —
// runs in a parallel effect gated on connect() + a 100ms settle. The iframe
// handshake wins that race and closes over an empty cap list, leaving voice
// plugins permanently rendering the "voice.media not granted" warning. The
// gate lets channel-view await loadSidebar before responding to uncorded.ready.
const capabilityLoads = new Map<string, Promise<void>>();
const capabilityResolvers = new Map<string, () => void>();

function beginCapabilityLoad(serverId: string): void {
  if (capabilityLoads.has(serverId)) return;
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  capabilityLoads.set(serverId, promise);
  capabilityResolvers.set(serverId, resolve);
}

function completeCapabilityLoad(serverId: string): void {
  const resolve = capabilityResolvers.get(serverId);
  if (!resolve) return;
  capabilityResolvers.delete(serverId);
  resolve();
}

/**
 * Resolves once loadSidebar has populated runtime capabilities for this
 * server, or after `timeoutMs` if the load hangs (so a stalled /plugins fetch
 * never freezes a plugin handshake). Returns immediately if no load was
 * scheduled — caller then reads whatever is currently in the map.
 */
export function awaitCapabilities(serverId: string, timeoutMs = 5000): Promise<void> {
  const pending = capabilityLoads.get(serverId);
  if (!pending) return Promise.resolve();
  return Promise.race([
    pending,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

// Test-only: lets the cap-gate regression test drive the gate without spinning
// up the full mountSidebarStore createEffect + loadSidebar flow.
export const __testing__ = { beginCapabilityLoad, completeCapabilityLoad };

export { sections, categories, sidebarLoading, sidebarError };

/**
 * Fetch /plugins with two layers of retry:
 *   1. Inner `retry()` — transient HTTP failures (502/503/521 etc) from
 *      Cloudflare's edge or the runtime.
 *   2. Outer empty-result retry — a 200 OK with `plugins: []` is a soft
 *      failure: it usually means we hit /plugins between the runtime binding
 *      HTTP and the registry actually being populated, or that the runtime
 *      returned a stale cached response. Wait briefly and refetch.
 *
 * Returns null on hard failure (non-ok response), or the plugin list (possibly
 * empty after exhausting soft retries — the caller treats that as an empty
 * server).
 */
async function fetchPluginListWithEmptyRetry(
  tunnelUrl: string,
): Promise<InstalledPlugin[] | null> {
  let attempt = 0;
  for (;;) {
    bootTrace("sidebar.fetchPlugins.attempt", { attempt, tunnelUrl });
    const resp = await retry(() => fetch(`${tunnelUrl}/plugins`), {
      attempts: 4,
      backoffMs: [500, 1500, 3000],
    });
    if (!resp.ok) {
      bootTrace("sidebar.fetchPlugins.notOk", { attempt, status: resp.status });
      return null;
    }
    const data = (await resp.json()) as { plugins: InstalledPlugin[] };
    bootTrace("sidebar.fetchPlugins.result", { attempt, count: data.plugins.length, slugs: data.plugins.map((p) => p.slug) });
    if (data.plugins.length > 0) return data.plugins;
    const delay = EMPTY_PLUGINS_RETRY_DELAYS_MS[attempt];
    // Exhausted on still-empty: treat as error rather than ready-with-zero.
    // Every healthy server has core plugins, so a persistent empty list
    // means the runtime is in a bad state — surface it instead of rendering
    // a silently-blank sidebar that's indistinguishable from "no plugins
    // installed."
    if (delay === undefined) {
      bootTrace("sidebar.fetchPlugins.exhausted", { attempts: attempt + 1 });
      return null;
    }
    bootTrace("sidebar.fetchPlugins.empty.retry", { attempt, delay });
    await new Promise<void>((r) => setTimeout(r, delay));
    attempt++;
  }
}

async function loadSidebar(serverId: string, tunnelUrl: string): Promise<void> {
  bootTrace("sidebar.loadSidebar.start", { serverId });
  setSidebarLoading(true);
  setSidebarError(false);
  try {
    const plugins = await fetchPluginListWithEmptyRetry(tunnelUrl);
    if (plugins === null) {
      bootTrace("sidebar.loadSidebar.pluginListNull", { serverId });
      setSections([]);
      setSidebarError(true);
      return;
    }

    // Update capability maps from the full plugin list (not just sidebar contributors).
    pluginCapabilities.clear();
    pluginRuntimeCapabilities.clear();
    pluginReadyState.clear();
    for (const p of plugins) {
      if (p.client_capabilities && p.client_capabilities.length > 0) {
        pluginCapabilities.set(p.slug, p.client_capabilities);
      }
      if (p.runtime_capabilities && p.runtime_capabilities.length > 0) {
        pluginRuntimeCapabilities.set(p.slug, p.runtime_capabilities);
      }
      // Only track explicit `ready: false`. Undefined-or-true means ready in
      // getPluginReady, so we don't need to populate the entry for those.
      if (p.ready === false) {
        pluginReadyState.set(p.slug, false);
      }
    }
    setReadyTick((n) => n + 1);

    const contributing = plugins.filter((p) => p.sidebar?.contributes);
    bootTrace("sidebar.contributing", { serverId, slugs: contributing.map((p) => p.slug) });

    const [sectionResults, cats] = await Promise.all([
      Promise.allSettled(
        contributing.map(async (p): Promise<SidebarSection> => {
          bootTrace("sidebar.itemsRequest.start", { serverId, slug: p.slug });
          // Plugins may return either the legacy bare `SidebarItem[]` shape
          // or the newer `{ items, adminActions? }` shape that lifts admin
          // actions to section scope so the create button is available even
          // with an empty item list. Accept both for forward + back compat.
          const result = await request<
            SidebarItem[] | { items?: SidebarItem[]; adminActions?: SidebarAction[] }
          >(serverId, p.slug, "sidebar.items", {});
          const items = Array.isArray(result)
            ? result
            : Array.isArray(result?.items) ? result.items : [];
          bootTrace("sidebar.itemsRequest.done", { serverId, slug: p.slug, itemCount: items.length, hasAdminActions: !Array.isArray(result) && Array.isArray(result?.adminActions) });
          const sectionAdminActions =
            !Array.isArray(result) && Array.isArray(result?.adminActions)
              ? result.adminActions
              : undefined;
          const section: SidebarSection = {
            slug: p.slug,
            section: p.sidebar?.section ?? p.name,
            items,
            refreshOn: p.sidebar?.refresh_on ?? [],
          };
          if (sectionAdminActions) section.adminActions = sectionAdminActions;
          return section;
        }),
      ),
      // Categories are server-wide, owned by Core. Treat a failure as "no
      // categories" rather than failing the whole sidebar — items just fall
      // into the uncategorized bucket.
      request<{ categories: CoreCategory[] }>(serverId, "core", "core.categories.list", {})
        .then((r) => r.categories)
        .catch(() => [] as CoreCategory[]),
    ]);

    // Log rejections so a silent failure (e.g. WS auth lost mid-load) is
    // diagnosable from the console instead of presenting as an empty sidebar.
    for (const r of sectionResults) {
      if (r.status === "rejected") {
        console.warn("[sidebar] section load failed:", r.reason);
      }
    }

    const successful = sectionResults
      .filter((r): r is PromiseFulfilledResult<SidebarSection> => r.status === "fulfilled")
      .map((r) => r.value);

    setCategories(cats);
    setSections(successful);
    bootTrace("sidebar.loadSidebar.done", { serverId, sectionCount: successful.length, sectionSlugs: successful.map((s) => s.slug) });

    // If every contributing plugin's sidebar.items rejected, the sidebar would
    // render as silently empty — surface an error so the user sees "Failed to
    // load sidebar" instead of a blank panel and knows to retry.
    if (contributing.length > 0 && successful.length === 0) {
      bootTrace("sidebar.loadSidebar.allRejected", { serverId });
      setSidebarError(true);
    }
  } catch (err) {
    bootTrace("sidebar.loadSidebar.threw", { serverId, error: String(err) });
    setSections([]);
    setCategories([]);
    setSidebarError(true);
  } finally {
    setSidebarLoading(false);
    completeCapabilityLoad(serverId);
  }
}

// Wire the store's reactive effects into the app's render tree. Call from
// App's top-level onMount so the createEffect has an owner — otherwise
// SolidJS warns "computations created outside a `createRoot` or `render`
// will never be disposed".
export function mountSidebarStore(): void {
  // Re-fetch sidebar on reconnect (e.g. after a dropped WS connection).
  onReconnect((connectedId) => {
    const id = activeServerId();
    const server = activeServer();
    if (connectedId !== id || !server?.tunnel_url) return;
    void loadSidebar(id, server.tunnel_url);
  });

  // Mark server online as soon as WS opens — don't wait for the next Central poll.
  onConnect((connectedId) => {
    patchServer(connectedId, { is_online: true });
  });

  // Re-fetch whenever the active server's identity or tunnel URL changes.
  // Tracking activeServer() directly would re-fire on every patchServer (incl.
  // is_online flips from onConnect), which spawns a connect() loop: each WS
  // open fires onConnect → patchServer → effect re-runs → new openConnection.
  // Memoize on the join string so unrelated field changes don't reach this effect.
  const activeKey = createMemo(() => {
    const id = activeServerId();
    const server = activeServer();
    if (!id || !server?.tunnel_url) return null;
    return `${id}|${server.tunnel_url}`;
  });

  createEffect(() => {
    const key = activeKey();

    if (!key) {
      bootTrace("sidebar.effect.noKey");
      setSections([]);
      pluginCapabilities.clear();
      pluginReadyState.clear();
      setReadyTick((n) => n + 1);
      return;
    }

    const sep = key.indexOf("|");
    const id = key.slice(0, sep);
    const tunnelUrl = key.slice(sep + 1);
    bootTrace("sidebar.effect.fire", { serverId: id, tunnelUrl });
    // Read the server object outside Solid's tracking scope so unrelated field
    // changes (is_online, connected_users) don't re-fire this effect — the
    // activeKey memo above is the single source of truth for what we react to.
    const server = untrack(activeServer);
    if (!server) {
      bootTrace("sidebar.effect.noServer", { serverId: id });
      return;
    }
    // Open the capability gate synchronously so any plugin handshake that
    // fires before the async loadSidebar below resolves will wait, instead of
    // racing past with an empty cap list. Closed in loadSidebar's finally.
    beginCapabilityLoad(id);
    let cancelled = false;
    // Unsubscribe handles captured per effect run. Without these, switching
    // servers repeatedly stacks duplicate __core_presence__ handlers and every
    // core.user.online event triggers adjustConnectedUsers once per stacked
    // handler, drifting the connected-users count upward over time.
    const unsubs: Array<() => void> = [];

    void (async () => {
      bootTrace("sidebar.effect.connect.await", { serverId: id });
      await connect(server);
      if (cancelled) {
        bootTrace("sidebar.effect.cancelled.afterConnect", { serverId: id });
        return;
      }
      bootTrace("sidebar.effect.connect.resolved", { serverId: id });
      // Wait for the WS auth handshake to actually complete before firing
      // sidebar.items requests. send() does queue unauth'd frames so this is
      // a UX optimization (avoid stacking requests in the queue while the
      // handshake is in flight) — but it also turns the previous fixed 100ms
      // guess into something deterministic on slow tunnels.
      const authStart = Date.now();
      while (
        !cancelled &&
        !isAuthenticated(id) &&
        Date.now() - authStart < AUTH_WAIT_TIMEOUT_MS
      ) {
        await new Promise<void>((r) => setTimeout(r, AUTH_WAIT_POLL_MS));
      }
      if (cancelled) {
        bootTrace("sidebar.effect.cancelled.afterAuthWait", { serverId: id });
        return;
      }
      bootTrace("sidebar.effect.authReady", { serverId: id, waitedMs: Date.now() - authStart, isAuth: isAuthenticated(id) });
      await loadSidebar(id, tunnelUrl);
      if (cancelled) return;

      // Subscribe to core presence events — updates connected_users count in real time.
      // core.user.online fires when any user's WS connects (including ourselves).
      // core.user.offline fires when any user's WS disconnects.
      unsubs.push(
        onPluginMessage(
          id,
          "__core_presence__",
          (msg: unknown) => {
            const ev = msg as { type?: string; topic?: string };
            if (ev.type !== "event") return;
            if (ev.topic === "core.user.online") adjustConnectedUsers(id, +1);
            else if (ev.topic === "core.user.offline") adjustConnectedUsers(id, -1);
          },
          "__core_presence__",
        ),
      );

      // Subscribe to the two-stage plugin handshake event. When a plugin that
      // declared `serve_ready_handshake: true` finishes its post-spawn init
      // and calls `sdk.serveReady()`, the runtime broadcasts this event and
      // we flip the row from greyed-out-loading to clickable.
      //
      // Doubles as a self-heal for the empty-sidebar warmup race: if the
      // initial /plugins came back empty (registry still hydrating) and the
      // empty-retry budget exhausted, sidebarError is true and sections is
      // empty. A subsequent plugin-ready broadcast means the registry is now
      // populated — re-run loadSidebar to pull a fresh list.
      unsubs.push(
        onPluginMessage(
          id,
          "__plugin_ready__",
          (msg: unknown) => {
            const ev = msg as {
              type?: string;
              topic?: string;
              payload?: { slug?: unknown; ready?: unknown };
            };
            if (ev.type !== "event" || ev.topic !== "runtime.plugin.ready") return;
            const slug = typeof ev.payload?.slug === "string" ? ev.payload.slug : null;
            const ready = ev.payload?.ready === true;
            if (slug === null || !ready) return;
            bootTrace("sidebar.event.pluginReady", { serverId: id, slug });
            pluginReadyState.set(slug, true);
            setReadyTick((n) => n + 1);
            if (sidebarError() || sections().length === 0) {
              bootTrace("sidebar.event.pluginReady.selfHeal", { serverId: id, slug });
              void loadSidebar(id, tunnelUrl);
            }
          },
          "__plugin_ready__",
        ),
      );

      // Subscribe to runtime.icon.changed — owner uploads a new server icon
      // via /admin/api/icon, runtime broadcasts, every viewer's <img> re-fetches
      // with a fresh ?v=<updatedAt> cache buster. Without this, viewers who
      // joined before the upload would stay on the SVG letter-avatar fallback
      // (the runtime serves it as a 200, so onError-driven retry never fires)
      // until they hard-refresh.
      unsubs.push(
        onPluginMessage(
          id,
          "__icon_changed__",
          (msg: unknown) => {
            const ev = msg as {
              type?: string;
              topic?: string;
              payload?: { updatedAt?: unknown };
            };
            if (ev.type !== "event" || ev.topic !== "runtime.icon.changed") return;
            const updatedAt = typeof ev.payload?.updatedAt === "number"
              ? ev.payload.updatedAt
              : Date.now();
            bootTrace("sidebar.event.iconChanged", { serverId: id, updatedAt });
            bumpServerIconVersion(id, updatedAt);
          },
          "__icon_changed__",
        ),
      );

      // Subscribe to refresh_on events so the sidebar updates live. Always
      // include the core.category.* topic family so admin category changes
      // re-flow grouping immediately, even if no contributing plugin opted in.
      const refreshEvents = new Set([
        ...sections().flatMap((s) => s.refreshOn),
        "core.category.created",
        "core.category.updated",
        "core.category.deleted",
        "core.category.reordered",
      ]);

      unsubs.push(
        onPluginMessage(
          id,
          "__sidebar__",
          (msg: unknown) => {
            const ev = msg as { type?: string; topic?: string };
            if (ev.type === "event" && ev.topic && refreshEvents.has(ev.topic)) {
              void loadSidebar(id, tunnelUrl);
            }
          },
          "__sidebar__",
        ),
      );
    })();

    onCleanup(() => {
      cancelled = true;
      // Release any handshake awaiters for this server. If we cancelled before
      // loadSidebar ran, its finally never fires — without this they'd wait
      // the full 5s timeout for an answer the gate is no longer trying to
      // produce. The iframe is being torn down anyway, so unblocking with
      // empty caps is harmless.
      completeCapabilityLoad(id);
      capabilityLoads.delete(id);
      for (const u of unsubs) u();
    });
  });
}
