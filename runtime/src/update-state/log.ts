// Disk-backed ring buffer for the runtime update log (Phase 01 §11.4).
//
// Surfaced by `GET /admin/api/update-log` to power the "logs" link from the
// runtime panel's error states (update-ux.md §4.4). Auto-populated by a
// listener on the update-state store wired in main.ts: every state-changing
// transition appends one entry, so the log is never empty after the first
// orchestrator action.
//
// Storage: JSONL at `<configDir>/update-log.jsonl`, one entry per line.
// Sync writes — same rationale as update-state/store.ts: writes happen on
// orchestrator-driven transitions (≤ a dozen per update), not on a hot path.
//
// Tolerant on read: malformed lines are skipped, not fatal. A corrupted log is
// far less critical than a corrupted state file — at worst the operator sees a
// truncated history. Hard-failing boot over a bad log file would be DoS.
//
// Bounded: the buffer holds at most MAX_ENTRIES (200) of the most recent
// entries. Oldest is evicted on append; the on-disk file is rewritten in full
// on every append so a long-running server doesn't grow the file unbounded.
// 200 × ~200 bytes = ~40 KB persisted — trivial.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rootLogger } from "@uncorded/shared";
import type { Logger } from "@uncorded/shared";
import type { RuntimeUpdateErrorContext, RuntimeUpdateStatus } from "./types";

const log: Logger = rootLogger.child({ component: "update-log" });

const MAX_ENTRIES = 200;

export interface UpdateLogEntry {
  /** Epoch ms — stamped by the runtime, never the caller. */
  ts: number;
  /** "error" when the state entered a terminal error or rolling-back; "info"
   *  for normal transitions. Used by the UI to colour entries. */
  level: "info" | "error";
  /** State the runtime transitioned INTO at this entry's timestamp. */
  state: RuntimeUpdateStatus;
  /** Mirrors update-state.errorContext at append time (null for non-error
   *  transitions). Lets the UI link the entry to a specific phase. */
  errorContext: RuntimeUpdateErrorContext;
  /** One-line, user-safe message. Mirrors update-state.errorMessage when set,
   *  otherwise a short "transitioned to <state>" string. */
  message: string;
}

export interface UpdateLogStore {
  /** Snapshot of all entries, oldest first. */
  getAll(): readonly UpdateLogEntry[];
  /** Append an entry; persists synchronously. Caller-supplied `ts` is
   *  overwritten with `now()` so every entry carries a clock the runtime trusts. */
  append(entry: Omit<UpdateLogEntry, "ts">): UpdateLogEntry;
  /** Drop every entry — used at the start of a new update attempt. */
  clear(): void;
}

export interface CreateUpdateLogStoreOptions {
  /** Absolute path to the persist file (typically /config/update-log.jsonl). */
  filePath: string;
  /** Injectable wall clock — defaults to Date.now. */
  now?: () => number;
}

export function createUpdateLogStore(
  options: CreateUpdateLogStoreOptions,
): UpdateLogStore {
  const now = options.now ?? Date.now;
  let entries: UpdateLogEntry[] = loadOrEmpty(options.filePath);

  function persist(): void {
    try {
      const body = entries.map((e) => JSON.stringify(e)).join("\n");
      writeFileSync(options.filePath, body);
    } catch (err) {
      // Same rationale as update-state/store.ts: persist failure is loud but
      // non-fatal. The in-memory log still serves /admin/api/update-log; the
      // next append will retry the write.
      log.error("update-log persist failed", {
        path: options.filePath,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    getAll(): readonly UpdateLogEntry[] {
      return entries;
    },
    append(entry: Omit<UpdateLogEntry, "ts">): UpdateLogEntry {
      const stamped: UpdateLogEntry = { ...entry, ts: now() };
      entries.push(stamped);
      if (entries.length > MAX_ENTRIES) {
        entries = entries.slice(entries.length - MAX_ENTRIES);
      }
      persist();
      return stamped;
    },
    clear(): void {
      entries = [];
      persist();
    },
  };
}

function loadOrEmpty(filePath: string): UpdateLogEntry[] {
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    log.warn("update-log file unreadable — falling back to empty", {
      path: filePath,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  const out: UpdateLogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isUpdateLogEntry(parsed)) {
        out.push(parsed);
      }
    } catch {
      // Skip malformed lines — see file header rationale.
    }
  }
  // Keep only the most recent MAX_ENTRIES if the file grew larger than expected
  // (e.g. an older runtime version with a bigger limit).
  return out.length > MAX_ENTRIES ? out.slice(out.length - MAX_ENTRIES) : out;
}

function isUpdateLogEntry(value: unknown): value is UpdateLogEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["ts"] === "number" &&
    (v["level"] === "info" || v["level"] === "error") &&
    typeof v["state"] === "string" &&
    (v["errorContext"] === null || typeof v["errorContext"] === "string") &&
    typeof v["message"] === "string"
  );
}
