// Local registry mapping Central server IDs to their Docker container and host
// volume path. Written after successful provisioning, read on delete/stop.
// Stored at ~/.uncorded/registry.json — separate from the per-server volumes.
//
// On-disk shape is a schemaVersion envelope so future additions (new fields,
// shape changes) can migrate without a silent data nuke. Corruption paths
// (bad JSON, invalid shape) rename the file to registry.quarantine-<ts>.json
// and write a fresh empty envelope — then a session flag signals the UI so
// the user sees a banner on startup instead of the registry mysteriously
// emptying out. Per-entry validation errors drop only the bad rows.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

export interface ServerRecord {
  containerId: string;
  volumePath: string;
  // Bound port on the host loopback (127.0.0.1:<hostPort> → container :3000).
  // Persisted so the desktop lifecycle (rm-f + docker run on every launch, see
  // main.ts) can keep the same address across container recreations — clients
  // and the runtime's UNCORDED_PUBLIC_URL env both depend on a stable URL.
  hostPort: number;
  // Optional Cloudflare tunnel hostname (e.g. "mygame.example.com"). Not a
  // secret; lives in the registry rather than the keychain so the lifecycle
  // restore path can rebuild the tunnel.json blob without prompting the user
  // every launch. The actual tunnel token stays in the OS keychain under
  // `tunnel:<serverId>`.
  tunnelPublicHostname?: string;
  // Optional voice signaling hostname (e.g. "voice.mygame.example.com"). Set
  // by the owner via the in-app "Open Router Ports" setup flow; restoreServerContainers
  // then exports LIVEKIT_PUBLIC_URL=wss://<host> on container start, which gates
  // the runtime's voice supervisor. Absent → /health/voice reports disabled and
  // the shell dims voice channels in the sidebar.
  voicePublicHostname?: string;
  // Phase 01 Danger Zone toggle: O3 default-on for the pre-update snapshot.
  // Stored as `false` only when the owner has explicitly disabled it via the
  // Runtime panel; absence (or `true`) means the orchestrator MUST snapshot
  // /data + /config before swapping. Per-server because mods/admins can
  // legitimately diverge on disk-pressure tradeoffs across the operator's
  // fleet (small dev box wants smaller footprints; gaming community keeps
  // safety net ON).
  backupBeforeUpdate?: boolean;
  // Cosign material the orchestrator already verified for the image currently
  // pointed at by `uncorded-runtime:latest`. Persisted so launch-time and
  // voice-hostname rebuild paths can re-supply RUNTIME_IMAGE_DIGEST/_PAYLOAD/
  // _SIGNATURE envs without re-pulling — without this, the runtime logs
  // "image signature verification skipped" on every restart even though we
  // verified at pull time. Refreshed on every successful update commit.
  imageSignature?: {
    digest: string;
    payloadJson: string;
    signatureB64: string;
  };
}

interface RegistryEnvelope {
  schemaVersion: 1;
  entries: Record<string, ServerRecord>;
}

const ServerRecordSchema = z.object({
  containerId: z.string(),
  volumePath: z.string(),
  hostPort: z.number().int().positive(),
  tunnelPublicHostname: z.string().optional(),
  voicePublicHostname: z.string().optional(),
  backupBeforeUpdate: z.boolean().optional(),
  imageSignature: z
    .object({
      digest: z.string(),
      payloadJson: z.string(),
      signatureB64: z.string(),
    })
    .optional(),
});

// Loose envelope check — validates the outer shape without touching entries.
// Per-entry validation runs separately so one bad row doesn't cause the whole
// file to be quarantined; it gets dropped in-place and the file rewritten
// clean. Quarantine is reserved for corruption that can't be partially saved.
const RegistryEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.record(z.string(), z.unknown()),
});

// Module-level quarantine state. Set by read() when it renames a corrupt file
// and reset to a clean envelope. Consumed at startup to surface a banner to
// the user via the APP_GET_STARTUP_NOTICES IPC.
let quarantinedThisSession = false;
let lastQuarantine: string | null = null;

export function registryWasQuarantinedThisSession(): boolean {
  return quarantinedThisSession;
}

export function lastQuarantinePath(): string | null {
  return lastQuarantine;
}

/** Test-only: reset session quarantine state. Bun runs test files in the same
 *  worker, so module-level flags leak across files without this hook. */
export function __resetQuarantineFlagForTests(): void {
  quarantinedThisSession = false;
  lastQuarantine = null;
}

function registryDir(): string {
  return join(homedir(), ".uncorded");
}

function registryPath(): string {
  return join(registryDir(), "registry.json");
}

function emptyEnvelope(): RegistryEnvelope {
  return { schemaVersion: 1, entries: {} };
}

function quarantine(reason: "json-parse" | "envelope-shape", rawText?: string): void {
  const p = registryPath();
  const ts = Date.now();
  const qPath = join(registryDir(), `registry.quarantine-${ts}.json`);
  try {
    if (existsSync(p)) {
      renameSync(p, qPath);
    } else if (rawText !== undefined) {
      // Edge case: the source bytes came from somewhere but the file already
      // vanished by rename time. Persist them so the quarantine copy isn't
      // empty and forensic analysis is still possible.
      writeFileSync(qPath, rawText, "utf8");
    }
  } catch (err) {
    // If rename fails (permissions, disk full) we still want to unblock the
    // app and surface a notice — log and continue rather than throw.
    console.error("[registry] quarantine rename failed", { reason, err });
  }
  // Always lay down a fresh envelope at the canonical path so subsequent
  // registerServer calls don't race against a missing file.
  try {
    mkdirSync(registryDir(), { recursive: true });
    writeFileSync(p, JSON.stringify(emptyEnvelope(), null, 2), "utf8");
  } catch (err) {
    console.error("[registry] failed to write empty envelope after quarantine", { err });
  }
  quarantinedThisSession = true;
  lastQuarantine = qPath;
  console.error("[registry] quarantined corrupt file", { reason, qPath });
}

// Zod's `.optional()` yields `T | undefined` which disagrees with the
// exactOptionalPropertyTypes variant `T | null | absent`. Narrow the parsed
// shape into a ServerRecord by omitting the optional key when it's undefined.
function normalizeRecord(parsed: z.infer<typeof ServerRecordSchema>): ServerRecord {
  return {
    containerId: parsed.containerId,
    volumePath: parsed.volumePath,
    hostPort: parsed.hostPort,
    ...(parsed.tunnelPublicHostname !== undefined
      ? { tunnelPublicHostname: parsed.tunnelPublicHostname }
      : {}),
    ...(parsed.voicePublicHostname !== undefined
      ? { voicePublicHostname: parsed.voicePublicHostname }
      : {}),
    ...(parsed.backupBeforeUpdate !== undefined
      ? { backupBeforeUpdate: parsed.backupBeforeUpdate }
      : {}),
    ...(parsed.imageSignature !== undefined
      ? { imageSignature: parsed.imageSignature }
      : {}),
  };
}

function migrateV0toV1(raw: unknown): RegistryEnvelope | null {
  // Pre-versioned shape: flat `Record<string, ServerRecord>` at the top level.
  // Anything that looks like a plain object with no `schemaVersion` key is a
  // candidate — parse each entry with the per-record schema and keep only the
  // ones that pass. This is the normal upgrade path, NOT corruption, so the
  // quarantine flag stays unset.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  if ("schemaVersion" in raw) return null;
  const envelope: RegistryEnvelope = emptyEnvelope();
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = ServerRecordSchema.safeParse(value);
    if (parsed.success) envelope.entries[id] = normalizeRecord(parsed.data);
    else console.warn("[registry] dropped invalid pre-migration entry", { id, issues: parsed.error.issues });
  }
  return envelope;
}

function read(): RegistryEnvelope {
  const p = registryPath();
  if (!existsSync(p)) return emptyEnvelope();

  let rawText: string;
  try {
    rawText = readFileSync(p, "utf8");
  } catch (err) {
    console.error("[registry] read failed", { err });
    return emptyEnvelope();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    quarantine("json-parse", rawText);
    return emptyEnvelope();
  }

  // Migration: pre-v1 flat shape has no `schemaVersion`.
  const migrated = migrateV0toV1(raw);
  if (migrated !== null) {
    try { write(migrated); } catch (err) {
      console.error("[registry] failed to persist migrated registry", { err });
    }
    return migrated;
  }

  const envelope = RegistryEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    quarantine("envelope-shape", rawText);
    return emptyEnvelope();
  }

  // Per-entry re-validate. Envelope-level parse already ran per-entry, but
  // this loop also handles the case where z.record accepts unknown extra
  // keys that later fail stricter checks. It's defensive but cheap.
  const cleaned: RegistryEnvelope = emptyEnvelope();
  let droppedAny = false;
  for (const [id, value] of Object.entries(envelope.data.entries)) {
    const parsed = ServerRecordSchema.safeParse(value);
    if (parsed.success) cleaned.entries[id] = normalizeRecord(parsed.data);
    else {
      droppedAny = true;
      console.warn("[registry] dropped invalid entry", { id, issues: parsed.error.issues });
    }
  }
  if (droppedAny) {
    try { write(cleaned); } catch (err) {
      console.error("[registry] failed to rewrite cleaned registry", { err });
    }
  }
  return cleaned;
}

function write(envelope: RegistryEnvelope): void {
  mkdirSync(registryDir(), { recursive: true });
  writeFileSync(registryPath(), JSON.stringify(envelope, null, 2), "utf8");
}

export function registerServer(serverId: string, record: ServerRecord): void {
  const envelope = read();
  envelope.entries[serverId] = record;
  write(envelope);
}

export function getServerRecord(serverId: string): ServerRecord | null {
  return read().entries[serverId] ?? null;
}

export function listServerRecords(): { serverId: string; record: ServerRecord }[] {
  const envelope = read();
  return Object.entries(envelope.entries).map(([serverId, record]) => ({ serverId, record }));
}

export function removeServerRecord(serverId: string): void {
  const envelope = read();
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete envelope.entries[serverId];
  write(envelope);
}
