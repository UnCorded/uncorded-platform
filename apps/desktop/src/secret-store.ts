import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { DESKTOP_APP_ID } from "./desktop-identity";
import { app, safeStorage } from "./electron-main-deps";

type SecretStoreBackend = "os-keyring" | "file-safe-storage";

interface SecretStore {
  backend: SecretStoreBackend;
  durableAcrossReinstall: boolean;
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): void;
}

type KeyringEntryCtor = new (service: string, name: string) => KeyringEntry;

export interface SecretStoreStatus {
  backend: SecretStoreBackend | "unavailable";
  durableAcrossReinstall: boolean;
  note: string;
}

export class SecretStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretStoreUnavailableError";
  }
}

/** Key for a server's persisted Cloudflare tunnel token. */
export function tunnelSecretKey(serverId: string): string {
  return `tunnel:${serverId}`;
}

/** Key for a server's persisted runtime encryption secret. The runtime
 *  uses this to derive at-rest crypto keys (e.g. the LiveKit API secret
 *  in plugin SQLite). Must remain stable across container restarts —
 *  rotating it makes previously-encrypted rows undecryptable. Cleared
 *  only on server purge, alongside the tunnel token. */
export function encryptionSecretKey(serverId: string): string {
  return `runtime-encryption:${serverId}`;
}

function secretFilePath(): string {
  return path.join(app.getPath("userData"), "keychain.json");
}

function loadFileSecretBlobs(): Record<string, string> {
  try {
    const raw = readFileSync(secretFilePath(), "utf8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveFileSecretBlobs(data: Record<string, string>): void {
  writeFileSync(secretFilePath(), JSON.stringify(data), "utf8");
}

function createFileSecretStore(): SecretStore {
  return {
    backend: "file-safe-storage",
    durableAcrossReinstall: false,
    get(key: string): string | null {
      const data = loadFileSecretBlobs();
      const blob = data[key];
      if (blob === undefined) return null;
      try {
        return safeStorage.decryptString(Buffer.from(blob, "base64"));
      } catch {
        return null;
      }
    },
    set(key: string, value: string): void {
      const data = loadFileSecretBlobs();
      const encrypted = safeStorage.encryptString(value);
      data[key] = encrypted.toString("base64");
      saveFileSecretBlobs(data);
    },
    delete(key: string): void {
      const data = loadFileSecretBlobs();
      delete data[key];
      saveFileSecretBlobs(data);
    },
  };
}

function keyringUnavailableError(): SecretStoreUnavailableError {
  return new SecretStoreUnavailableError(
    "Packaged desktop builds require an OS-backed secret store. " +
      "Install or unlock the platform credential service and relaunch UnCorded. " +
      "On Linux, Secret Service/libsecret support is required.",
  );
}

function loadKeyringEntryCtor(): KeyringEntryCtor | null {
  try {
    const mod = require("@napi-rs/keyring") as { Entry?: unknown };
    return typeof mod.Entry === "function" ? mod.Entry as KeyringEntryCtor : null;
  } catch {
    return null;
  }
}

function createOsSecretStore(): SecretStore | null {
  const Entry = loadKeyringEntryCtor();
  if (!Entry) return null;
  const KeyringEntry = Entry;

  try {
    // Probe once so packaged builds fail closed when the platform credential
    // service is missing or locked instead of silently degrading to a less
    // durable store.
    void new KeyringEntry(DESKTOP_APP_ID, "__uncorded_probe__");
  } catch {
    return null;
  }

  function entryFor(key: string): KeyringEntry {
    try {
      return new KeyringEntry(DESKTOP_APP_ID, key);
    } catch {
      throw keyringUnavailableError();
    }
  }

  return {
    backend: "os-keyring",
    durableAcrossReinstall: true,
    get(key: string): string | null {
      try {
        return entryFor(key).getPassword();
      } catch (err) {
        if (err instanceof SecretStoreUnavailableError) throw err;
        return null;
      }
    },
    set(key: string, value: string): void {
      try {
        entryFor(key).setPassword(value);
      } catch (err) {
        if (err instanceof SecretStoreUnavailableError) throw err;
        throw keyringUnavailableError();
      }
    },
    delete(key: string): void {
      try {
        entryFor(key).deletePassword();
      } catch (err) {
        if (err instanceof SecretStoreUnavailableError) throw err;
        throw keyringUnavailableError();
      }
    },
  };
}

function resolveSecretStore(): SecretStore {
  const osStore = createOsSecretStore();
  if (osStore) return osStore;
  if (!app.isPackaged) return createFileSecretStore();
  throw keyringUnavailableError();
}

export function getSecretStoreStatus(): SecretStoreStatus {
  try {
    const store = resolveSecretStore();
    if (store.backend === "os-keyring") {
      return {
        backend: store.backend,
        durableAcrossReinstall: store.durableAcrossReinstall,
        note: "Secrets are stored in the operating system credential manager.",
      };
    }
    return {
      backend: store.backend,
      durableAcrossReinstall: store.durableAcrossReinstall,
      note: "Dev-only fallback: app-local safeStorage file. Reinstall/update durability is not guaranteed.",
    };
  } catch (err) {
    return {
      backend: "unavailable",
      durableAcrossReinstall: false,
      note: err instanceof Error ? err.message : "Secret store unavailable",
    };
  }
}

export function getSecret(key: string): string | null {
  return resolveSecretStore().get(key);
}

export function setSecret(key: string, value: string): void {
  resolveSecretStore().set(key, value);
}

export function deleteSecret(key: string): void {
  resolveSecretStore().delete(key);
}

/**
 * Run idempotent secret migrations on app start.
 *
 * Contract:
 * - Packaged desktop builds must use an OS-backed credential store.
 * - Updates and reinstalls under the same OS user + stable app id preserve secrets.
 * - Dev mode may fall back to an app-local safeStorage file for convenience.
 */
export function migrateSecrets(): void {
  const store = resolveSecretStore();
  migrateLegacyFileSecretsToCurrentStore(store);
  migrateTunnelJsonFilesToStore(store);
}

function migrateLegacyFileSecretsToCurrentStore(store: SecretStore): void {
  if (store.backend === "file-safe-storage") return;
  const filePath = secretFilePath();
  if (!existsSync(filePath)) return;

  const legacy = loadFileSecretBlobs();
  let hadWriteFailure = false;

  for (const [key, blob] of Object.entries(legacy)) {
    try {
      const decrypted = safeStorage.decryptString(Buffer.from(blob, "base64"));
      store.set(key, decrypted);
    } catch {
      hadWriteFailure = true;
    }
  }

  if (!hadWriteFailure) {
    try {
      unlinkSync(filePath);
    } catch {
      // Best effort — leaving the legacy file in place is safer than crashing.
    }
  }
}

function migrateTunnelJsonFilesToStore(store: SecretStore): void {
  const registryPath = path.join(homedir(), ".uncorded", "registry.json");
  if (!existsSync(registryPath)) return;

  let registry: Record<string, { volumePath?: string }>;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8")) as Record<string, { volumePath?: string }>;
  } catch {
    return;
  }

  for (const [serverId, record] of Object.entries(registry)) {
    const volumePath = record.volumePath;
    if (typeof volumePath !== "string") continue;
    const tunnelJson = path.join(volumePath, "config", "tunnel.json");
    if (!existsSync(tunnelJson)) continue;
    try {
      const raw = readFileSync(tunnelJson, "utf8");
      const parsed = JSON.parse(raw) as { tunnel_token?: unknown };
      const token = typeof parsed.tunnel_token === "string" ? parsed.tunnel_token : null;
      if (token && token.length > 0) {
        store.set(tunnelSecretKey(serverId), token);
      }
      unlinkSync(tunnelJson);
    } catch {
      // Best effort — leave the file in place for manual inspection.
    }
  }

  const serversRoot = path.join(homedir(), ".uncorded", "servers");
  if (!existsSync(serversRoot)) return;
  let entries: string[];
  try {
    entries = readdirSync(serversRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    const stray = path.join(serversRoot, entry, "config", "tunnel.json");
    try {
      if (existsSync(stray) && statSync(stray).isFile()) {
        unlinkSync(stray);
      }
    } catch {
      // Best effort
    }
  }
}
