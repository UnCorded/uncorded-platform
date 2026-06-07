// Static host for apps/website/dist. Runs locally; a cloudflared named
// tunnel is expected to route uncorded.app → http://localhost:${WEBSITE_PORT}.
//
// Usage: bun run serve:website
//
// Before running, build the site: bun run build:website
//
// Not a production web server — no compression, no caching headers beyond
// defaults, no request queuing. For the Phase 1 hybrid deployment (shell on
// uncorded.app, auth via cross-origin cookies to central.uncorded.app) this
// covers the loop while we validate that cookies survive the subdomain hop.

import { existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

const PORT = Number(process.env["WEBSITE_PORT"] ?? 5180);
const DIST = resolve(import.meta.dir, "..", "apps", "website", "dist");
const INDEX = join(DIST, "index.html");

if (!existsSync(INDEX)) {
  console.error(
    JSON.stringify({
      level: "error",
      component: "serve-website",
      msg: "apps/website/dist/index.html missing — run `bun run build:website` first",
      dist: DIST,
    }),
  );
  process.exit(1);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

// Resolve a request path to a real file under DIST, rejecting any path that
// would escape DIST via ".." or absolute-path tricks.
function resolveUnderDist(urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const stripped = decoded === "/" ? "/index.html" : decoded;
  const candidate = normalize(join(DIST, stripped));
  if (!candidate.startsWith(DIST + sep) && candidate !== DIST) return null;
  return candidate;
}

function logRequest(req: Request, status: number, bytes: number): void {
  const url = new URL(req.url);
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      component: "serve-website",
      method: req.method,
      path: url.pathname,
      status,
      bytes,
    }),
  );
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") {
      logRequest(req, 405, 0);
      return new Response("Method Not Allowed", { status: 405 });
    }

    const resolved = resolveUnderDist(url.pathname);
    if (!resolved) {
      logRequest(req, 403, 0);
      return new Response("Forbidden", { status: 403 });
    }

    // Hashed asset files (/assets/<name>-<hash>.<ext>) are content-addressed
    // so they can be cached aggressively. HTML and the root index must never
    // be CDN-cached since we serve the same path as the SPA entry and can't
    // invalidate on every deploy otherwise.
    const cacheHeader = url.pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache, no-store, must-revalidate";

    // Existing file → serve it.
    if (existsSync(resolved) && statSync(resolved).isFile()) {
      const file = Bun.file(resolved);
      const ext = extname(resolved).toLowerCase();
      const type = MIME[ext] ?? "application/octet-stream";
      logRequest(req, 200, file.size);
      return new Response(file, {
        headers: { "Content-Type": type, "Cache-Control": cacheHeader },
      });
    }

    // Unmatched path → SPA fallback to index.html so client-side router can
    // handle routes like /server/:id that have no corresponding file.
    const index = Bun.file(INDEX);
    logRequest(req, 200, index.size);
    return new Response(index, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  },
});

console.log(
  JSON.stringify({
    ts: new Date().toISOString(),
    level: "info",
    component: "serve-website",
    msg: "serving apps/website/dist",
    port: server.port,
    dist: DIST,
  }),
);
