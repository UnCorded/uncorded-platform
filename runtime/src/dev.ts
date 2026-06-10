// Dev-mode entrypoint — boots a real server locally without Docker, Central,
// or Cloudflare. For manual testing during development.
//
// Usage:
//   bun run runtime/src/dev.ts
//   bun run runtime/src/dev.ts --persist   # reuse ./dev-data/ across runs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { rootLogger } from "@uncorded/shared";
import { boot } from "./main";
import type { TunnelProvider, ServerJsonConfig, BootDependencies } from "./main";
import type { TokenValidator } from "./ws/types";

const log = rootLogger.child({ component: "dev" });

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const persist = process.argv.includes("--persist");

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const projectRoot = resolve(import.meta.dir, "..", "..");
const persistDir = join(projectRoot, "dev-data");

let dataDir: string;
if (persist) {
  dataDir = persistDir;
  mkdirSync(dataDir, { recursive: true });
  log.info("using persistent data directory", { dataDir });
} else {
  dataDir = mkdtempSync(join(tmpdir(), "uncorded-dev-"));
  log.info("using temporary data directory", { dataDir });
}

// Ensure plugin data subdirectory exists
mkdirSync(join(dataDir, "plugins", "text-channels"), { recursive: true, mode: 0o700 });

// ---------------------------------------------------------------------------
// Mock tunnel provider
// ---------------------------------------------------------------------------

const DEV_PORT = 3000;

const tunnelProvider: TunnelProvider = {
  async start() {
    return `http://localhost:${String(DEV_PORT)}`;
  },
  async stop() {},
  getUrl() {
    return `http://localhost:${String(DEV_PORT)}`;
  },
  getState() {
    return "local";
  },
  async healthCheck() {
    return true;
  },
};

// ---------------------------------------------------------------------------
// Dev token validator — accepts any token, returns a fixed user
// ---------------------------------------------------------------------------

const devTokenValidator: TokenValidator = {
  async validate() {
    return {
      ok: true as const,
      user: {
        id: "dev-user",
        username: "developer",
        displayName: "Developer",
        avatarUrl: "",
        role: "owner",
      },
      jti: "dev-jti",
    };
  },
};

// ---------------------------------------------------------------------------
// Mock Central — minimal HTTP server for heartbeat
// ---------------------------------------------------------------------------

let heartbeatCallCount = 0;

const centralServer = Bun.serve({
  port: 0, // random available port
  fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && /^\/v1\/servers\/[^/]+\/heartbeat$/.test(url.pathname)) {
      heartbeatCallCount++;
      if (heartbeatCallCount === 1) {
        return Response.json({
          dirty: true,
          sync_version: 1,
          public_keys: [
            { id: "dev-key-1", public_key: { kty: "OKP", crv: "Ed25519", x: "" } },
          ],
          deltas: [],
        });
      }
      return Response.json({ dirty: false });
    }
    return new Response("Not Found", { status: 404 });
  },
});

const centralUrl = `http://localhost:${String(centralServer.port)}`;
log.info("mock central listening", { url: centralUrl });

// ---------------------------------------------------------------------------
// Dev server.json
// ---------------------------------------------------------------------------

const configDir = join(dataDir, "config");
mkdirSync(configDir, { recursive: true });
const configPath = join(configDir, "server.json");

const serverConfig: ServerJsonConfig = {
  server_id: "dev-server",
  server_secret: "dev-secret",
  central_url: centralUrl,
  central_public_keys: undefined,
  last_sync_version: undefined,
  installed_plugins: ["text-channels"],
  tunnel: {
    provider: "none",
    mode: "dev",
    credentials_file: undefined,
    fallback: undefined,
  },
  settings: {
    permissive_mode: true,
    max_connections: 100,
    allow_unsigned_plugins: true,
    // Dev origins: localhost:5173 (Electron dev), localhost:5174 (web dev
    // server), and uncorded.app (public shell) so the dev runtime accepts
    // cross-origin fetches from every shell target without manual config.
    allowed_origins: [
      "http://localhost:5173",
      "http://localhost:5174",
      "https://uncorded.app",
    ],
  },
};

writeFileSync(configPath, JSON.stringify(serverConfig, null, 2));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const pluginsDir = join(projectRoot, "plugins");

const deps: BootDependencies = {
  tunnelProvider,
  tokenValidator: devTokenValidator,
  configPath,
  corePluginsDir: pluginsDir,
  userPluginsDir: pluginsDir,
  dataDir,
  runtimeVersion: process.env["RUNTIME_VERSION"] ?? "0.0.0-dev",
  port: DEV_PORT,
};

try {
  const result = await boot(deps);

  log.info("dev server ready", {
    port: result.port,
    httpUrl: `http://localhost:${String(result.port)}`,
    wsUrl: `ws://localhost:${String(result.port)}/ws`,
    chatUiUrl: `http://localhost:${String(result.port)}/plugins/text-channels/ui/`,
    pluginCount: result.pluginCount,
  });

  async function cleanup() {
    log.info("shutting down");
    await result.shutdown();
    centralServer.stop();
    if (!persist) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
        log.info("cleaned up temp directory");
      } catch {
        // Best-effort cleanup
      }
    }
    process.exit(0);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
} catch (err) {
  log.error("boot failed", {
    err: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  centralServer.stop();
  if (!persist) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  }
  process.exit(1);
}
