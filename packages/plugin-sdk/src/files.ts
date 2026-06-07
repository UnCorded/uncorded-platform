// Files — wraps the storage.file IPC calls (spec-26).
//
// The plugin uses this API to:
//   - `stat(filename)`         — check whether a previously-uploaded file
//                                 still exists on disk (orphan GC pre-check).
//   - `signUrl(filename, uid)` — mint a short-lived signed URL bound to a
//                                 specific user — what the plugin returns to
//                                 clients in message rows.
//   - `delete(filename)`       — remove a file (orphan cleanup).
//   - `list()`                 — enumerate the plugin's uploads/ directory
//                                 (used by the hourly GC sweep).
//
// The HTTP upload endpoint is hit directly by clients (POST /upload). The
// runtime notifies the plugin via the `file.uploaded` IPC frame, which the
// plugin SDK exposes through `createPlugin({ onFileUploaded })`.

import { z } from "zod";
import type { createRequestClient } from "./request";
import { unknownResult } from "./schemas";

const FileStatResult = z.object({
  exists: z.boolean(),
  size: z.number(),
  mtime: z.number(),
});

const FileSignUrlResult = z.object({
  url: z.string(),
  exp: z.number(),
});

const FileListResult = z.array(
  z.object({
    filename: z.string(),
    size: z.number(),
    mtime: z.number(),
  }),
);

const FileDeleteResult = z.object({ deleted: z.boolean() });

export interface FileStat {
  exists: boolean;
  size: number;
  /** Unix-ms mtime. */
  mtime: number;
}

export interface FileListEntry {
  filename: string;
  size: number;
  mtime: number;
}

export interface SignedFile {
  /** Path + query string (no scheme/host). Client appends server origin. */
  url: string;
  /** Unix-seconds expiry of the signature. */
  exp: number;
}

export interface FilesApi {
  /** Check whether `filename` exists in this plugin's uploads/ directory. */
  stat(filename: string): Promise<FileStat>;
  /**
   * Mint a signed URL bound to `userId`. The URL is path-only (no host);
   * the client prefixes its current server origin at render time so the
   * URL survives Cloudflare tunnel hostname changes.
   *
   * `ttlSeconds` defaults to 3600 (1 hour). The runtime caps at 86400 (24h).
   */
  signUrl(filename: string, userId: string, ttlSeconds?: number): Promise<SignedFile>;
  /** Delete a file. Returns `{ deleted: false }` if the file did not exist. */
  delete(filename: string): Promise<{ deleted: boolean }>;
  /** List all non-temporary files in this plugin's uploads/ directory. */
  list(): Promise<FileListEntry[]>;
}

export function createFilesApi(client: ReturnType<typeof createRequestClient>): FilesApi {
  return {
    async stat(filename: string): Promise<FileStat> {
      return client.sendAndWait(FileStatResult, {
        type: "storage.file",
        method: "stat",
        filename,
      });
    },

    async signUrl(filename: string, userId: string, ttlSeconds?: number): Promise<SignedFile> {
      return client.sendAndWait(FileSignUrlResult, {
        type: "storage.file",
        method: "signUrl",
        filename,
        user_id: userId,
        ...(ttlSeconds !== undefined ? { ttl_seconds: ttlSeconds } : {}),
      });
    },

    async delete(filename: string): Promise<{ deleted: boolean }> {
      return client.sendAndWait(FileDeleteResult, {
        type: "storage.file",
        method: "delete",
        filename,
      });
    },

    async list(): Promise<FileListEntry[]> {
      return client.sendAndWait(FileListResult, {
        type: "storage.file",
        method: "list",
      });
    },
  };
}

// Suppress unused-import warning in CI/strict mode without polluting downstream.
void unknownResult;
