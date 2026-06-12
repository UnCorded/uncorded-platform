// Local, desktop-owned store for "Web Apps" — browser-pane URLs the user has
// promoted to persistent, login-sticky webview panels in the sidebar.
//
// Scope: PER-SERVER, but NOT saved by the runtime/Central. Each server has its
// own set of web apps (keyed by serverId); the desktop owns the storage. The
// login itself lives in the shared `persist:browser` partition, so only the
// bookmark list is filed here — the cookies travel globally. website + mobile
// can't host <webview>, so they never hold these; the renderer gates the whole
// feature on isElectron().
//
// Stored at ~/.uncorded/web-apps.json next to registry.json. Same on-disk
// discipline as server-registry.ts: a schemaVersion envelope so future shape
// changes can migrate, and corruption (bad JSON / bad envelope) renames the
// file to web-apps.quarantine-<ts>.json and lays down a fresh empty envelope
// rather than silently nuking — the app keeps working with an empty list.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WebApp, WebAppPref } from "@uncorded/electron-bridge";

export type { WebApp, WebAppPref };

interface WebAppsEnvelope {
  schemaVersion: 1;
  // serverId -> (webAppId -> WebApp)
  servers: Record<string, Record<string, WebApp>>;
  // Per-URL "don't ask again" choice for the dock overlay: exact URL -> the
  // action to take (pop out vs save as Web App). Global (not per-server) — the
  // choice is about the URL, not which server you opened it from.
  urlPrefs: Record<string, WebAppPref>;
}

const WebAppSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  faviconUrl: z.string().optional(),
  addedAt: z.number(),
});

// Loose envelope check — validates the outer shape without trusting entries.
// Per-entry validation runs separately so one bad row doesn't quarantine the
// whole file; it gets dropped in-place and the file rewritten clean. `urlPrefs`
// is parsed loosely (unknown values) and cleaned per-entry for the same reason,
// and is optional so files written before this field existed (which carried a
// now-removed `dismissedHosts` array — stripped by z.object) load cleanly.
const WebAppsEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  servers: z.record(z.string(), z.record(z.string(), z.unknown())),
  urlPrefs: z.record(z.string(), z.unknown()).optional(),
});

const WebAppPrefSchema = z.enum(["popout", "panel"]);

let quarantinedThisSession = false;
let lastQuarantine: string | null = null;

export function webAppsWereQuarantinedThisSession(): boolean {
  return quarantinedThisSession;
}

export function lastWebAppsQuarantinePath(): string | null {
  return lastQuarantine;
}

/** Test-only: reset session quarantine state (Bun leaks module state across files). */
export function __resetWebAppsQuarantineForTests(): void {
  quarantinedThisSession = false;
  lastQuarantine = null;
}

function storeDir(): string {
  return join(homedir(), ".uncorded");
}

function storePath(): string {
  return join(storeDir(), "web-apps.json");
}

function emptyEnvelope(): WebAppsEnvelope {
  return { schemaVersion: 1, servers: {}, urlPrefs: {} };
}

function quarantine(reason: "json-parse" | "envelope-shape", rawText?: string): void {
  const p = storePath();
  const ts = Date.now();
  const qPath = join(storeDir(), `web-apps.quarantine-${ts}.json`);
  try {
    if (existsSync(p)) {
      renameSync(p, qPath);
    } else if (rawText !== undefined) {
      writeFileSync(qPath, rawText, "utf8");
    }
  } catch (err) {
    console.error("[web-apps] quarantine rename failed", { reason, err });
  }
  try {
    mkdirSync(storeDir(), { recursive: true });
    writeFileSync(p, JSON.stringify(emptyEnvelope(), null, 2), "utf8");
  } catch (err) {
    console.error("[web-apps] failed to write empty envelope after quarantine", { err });
  }
  quarantinedThisSession = true;
  lastQuarantine = qPath;
  console.error("[web-apps] quarantined corrupt file", { reason, qPath });
}

// Zod's `.optional()` yields `T | undefined`, which disagrees with
// exactOptionalPropertyTypes. Narrow into a WebApp by omitting faviconUrl when
// it's absent.
function normalizeWebApp(parsed: z.infer<typeof WebAppSchema>): WebApp {
  return {
    id: parsed.id,
    url: parsed.url,
    title: parsed.title,
    addedAt: parsed.addedAt,
    ...(parsed.faviconUrl !== undefined ? { faviconUrl: parsed.faviconUrl } : {}),
  };
}

function read(): WebAppsEnvelope {
  const p = storePath();
  if (!existsSync(p)) return emptyEnvelope();

  let rawText: string;
  try {
    rawText = readFileSync(p, "utf8");
  } catch (err) {
    console.error("[web-apps] read failed", { err });
    return emptyEnvelope();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    quarantine("json-parse", rawText);
    return emptyEnvelope();
  }

  const envelope = WebAppsEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    quarantine("envelope-shape", rawText);
    return emptyEnvelope();
  }

  // Per-entry re-validate: z.record accepts unknown values, so drop any row
  // that fails the stricter WebApp schema rather than trusting the loose parse.
  const cleanPrefs: Record<string, WebAppPref> = {};
  for (const [url, value] of Object.entries(envelope.data.urlPrefs ?? {})) {
    const parsed = WebAppPrefSchema.safeParse(value);
    if (parsed.success) cleanPrefs[url] = parsed.data;
  }
  const cleaned: WebAppsEnvelope = {
    schemaVersion: 1,
    servers: {},
    urlPrefs: cleanPrefs,
  };
  let droppedAny = false;
  for (const [serverId, apps] of Object.entries(envelope.data.servers)) {
    const cleanApps: Record<string, WebApp> = {};
    for (const [id, value] of Object.entries(apps)) {
      const parsed = WebAppSchema.safeParse(value);
      if (parsed.success) cleanApps[id] = normalizeWebApp(parsed.data);
      else {
        droppedAny = true;
        console.warn("[web-apps] dropped invalid entry", { serverId, id, issues: parsed.error.issues });
      }
    }
    cleaned.servers[serverId] = cleanApps;
  }
  if (droppedAny) {
    try { write(cleaned); } catch (err) {
      console.error("[web-apps] failed to rewrite cleaned store", { err });
    }
  }
  return cleaned;
}

function write(envelope: WebAppsEnvelope): void {
  mkdirSync(storeDir(), { recursive: true });
  writeFileSync(storePath(), JSON.stringify(envelope, null, 2), "utf8");
}

// Stable ordering: oldest-added first, so the sidebar list doesn't reshuffle.
function sortByAddedAt(apps: Record<string, WebApp>): WebApp[] {
  return Object.values(apps).sort((a, b) => a.addedAt - b.addedAt);
}

export function listWebApps(serverId: string): WebApp[] {
  return sortByAddedAt(read().servers[serverId] ?? {});
}

export function addWebApp(
  serverId: string,
  input: { url: string; title?: string; faviconUrl?: string },
): WebApp {
  const envelope = read();
  const apps = envelope.servers[serverId] ?? {};

  // Idempotent: adding a URL already pinned for this server returns the
  // existing entry (the toolbar "+" reflects already-added without duplicating).
  const url = input.url.trim();
  const existing = Object.values(apps).find((a) => a.url === url);
  if (existing) return existing;

  const entry: WebApp = {
    id: randomUUID(),
    url,
    title: input.title?.trim() || deriveTitle(url),
    addedAt: Date.now(),
    ...(input.faviconUrl !== undefined ? { faviconUrl: input.faviconUrl } : {}),
  };
  apps[entry.id] = entry;
  envelope.servers[serverId] = apps;
  write(envelope);
  return entry;
}

export function removeWebApp(serverId: string, id: string): void {
  const envelope = read();
  const apps = envelope.servers[serverId];
  if (!apps) return;
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete apps[id];
  write(envelope);
}

// The dock overlay's "save preference for this URL" — keyed by the exact URL,
// not the host (a different page on the same site asks again). Returns null
// when the user hasn't chosen a remembered action for this URL yet.
export function getUrlPref(url: string): WebAppPref | null {
  return read().urlPrefs[url.trim()] ?? null;
}

export function setUrlPref(url: string, action: WebAppPref): void {
  const envelope = read();
  envelope.urlPrefs[url.trim()] = action;
  write(envelope);
}

// Fallback title when the caller didn't supply one: the URL's hostname without
// a leading www. (e.g. "app.roll20.net"). Falls back to the raw URL if it
// won't parse.
function deriveTitle(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
