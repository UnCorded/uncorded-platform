import { createDb } from "./db";
import { ensureSigningKey, rotateSigningKey } from "./crypto";
import { createRateLimiter } from "./middleware";
import { createRouter } from "./routes";
import { createEmailClient } from "./email";
import { createR2Client } from "./r2";
import { sweepExpiredTransfers } from "./routes/server-transfer";
import { getPostLoginRedirect, isAllowedPostLoginRedirect } from "./post-login";
import { wrapWithAccessLog } from "./access-log";
import { runShutdown } from "./shutdown";
import { rootLogger } from "@uncorded/shared";
import { resolve } from "node:path";

const log = rootLogger.child({ component: "central" });

const PORT = Number(process.env["PORT"] ?? 4000);

// Secure-by-default: only "development" and "test" enable the permissive
// dev paths (verification-URL stdout fallback, captcha bypass, etc.). Any
// other value — including unset, "prod" typos, "staging", "production" —
// is treated as production so misconfiguration fails closed instead of
// silently leaking tokens via dev fallbacks.
const nodeEnv = process.env["NODE_ENV"];
const isProd = nodeEnv !== "development" && nodeEnv !== "test";

// Boot identity surfaced via /health so operators can verify which build is
// actually running (no more "is the deploy live yet?" guessing). Version is
// read once at boot from the workspace manifest; commit is whatever the build
// pipeline injects (Docker --build-arg / CI env). Both fall back to "unknown"
// so a stripped binary still answers /health correctly.
const startedAt = Date.now();
let pkgVersion = "unknown";
try {
  const pkgPath = resolve(import.meta.dir, "..", "package.json");
  const pkg = (await Bun.file(pkgPath).json()) as { version?: unknown };
  if (typeof pkg.version === "string" && pkg.version.length > 0) {
    pkgVersion = pkg.version;
  }
} catch (err: unknown) {
  log.warn("could not read package.json for version", {
    err: err instanceof Error ? err.message : String(err),
  });
}
const buildCommit = process.env["BUILD_COMMIT"]?.trim() || "unknown";
const bootInfo = { version: pkgVersion, commit: buildCommit, startedAt };
log.info("boot identity", bootInfo);

// Boot-time env enforcement. In production (the default — see `isProd`)
// any required secret missing or shorter than its minimum is a hard exit:
// silent degradation of auth, OAuth, or CAPTCHA in prod is a footgun, and
// the per-subsystem dev fallbacks (e.g. logging the verification URL when
// RESEND_API_KEY is unset) leak tokens to log aggregators. Dev mode is
// opt-in (NODE_ENV=development|test) and is the only path that allows
// missing values + warn-and-continue.
function requireInProd(name: string, opts: { minLength?: number } = {}): void {
  const value = process.env[name];
  const minLength = opts.minLength ?? 1;
  const present = value !== undefined && value.length >= minLength;
  if (present) {
    log.info("env var present", { var: name });
    return;
  }
  if (isProd) {
    log.error("required env var missing or too short in production", {
      var: name,
      ...(opts.minLength !== undefined ? { minLength } : {}),
    });
    process.exit(1);
  }
}

requireInProd("SIGNING_KEY_SECRET");
requireInProd("OAUTH_STATE_SECRET", { minLength: 32 });
requireInProd("APP_BASE_URL");
// POST_LOGIN_REDIRECT is where every browser-initiated auth flow lands (OAuth
// callback success, email verification success/failure). The default is the
// Vite dev port, so an unset prod var silently bounces every verified user
// to a URL they can't reach. Fail loud at boot instead.
requireInProd("POST_LOGIN_REDIRECT");
requireInProd("RESEND_API_KEY");
requireInProd("TURNSTILE_SECRET_KEY");
requireInProd("DB_PASSWORD");

// Validate the post-login redirect against the allowlist before any further
// boot work. A misconfigured value here turns every OAuth callback and
// email-verify success into an open redirect, so fail loud at boot rather
// than silently honoring whatever the operator set. This runs in dev too
// because the dev fallback ("http://localhost:5174") is on the allowlist —
// so the only thing this rejects in dev is an explicit override to a
// non-allowlisted value.
{
  const value = getPostLoginRedirect();
  if (!isAllowedPostLoginRedirect(value)) {
    log.error("POST_LOGIN_REDIRECT is not on the allowlist", {
      value,
      allowlist: "https://uncorded.app, https://*.uncorded.app, http://localhost, http://127.0.0.1",
    });
    process.exit(1);
  }
}

const sql = createDb({
  host: process.env["DB_HOST"] ?? "localhost",
  port: Number(process.env["DB_PORT"] ?? 5432),
  database: process.env["DB_NAME"] ?? "uncorded_central",
  username: process.env["DB_USER"] ?? "postgres",
  password: process.env["DB_PASSWORD"] ?? "postgres",
});

// Ensure Ed25519 signing key exists on boot; schedule 24-hour rotation. The
// interval handle is captured so shutdown() can clearInterval before sql.end()
// — without that there's a tiny race where a rotation fires against a closed
// pool and logs a misleading error during otherwise-clean shutdown.
let rotationInterval: ReturnType<typeof setInterval> | null = null;
let transferSweepInterval: ReturnType<typeof setInterval> | null = null;

if (process.env["SIGNING_KEY_SECRET"]) {
  await ensureSigningKey(sql);
  log.info("signing key ready");

  const ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  rotationInterval = setInterval(() => {
    rotateSigningKey(sql)
      .then(() => log.info("signing key rotated"))
      .catch((err: unknown) =>
        log.error("signing key rotation failed", {
          err: err instanceof Error ? err.message : String(err),
        }),
      );
  }, ROTATION_INTERVAL_MS);
} else {
  log.warn("no active signing key — SIGNING_KEY_SECRET not set (running in dev mode)");
}

// Periodic sweep of expired server-ownership transfers. Runs hourly so the
// `is_pending` flag tracks reality without us racing on the partial unique
// index for "one pending per server". The initiate handler also runs an inline
// sweep on its own row so users don't wait for this to retry.
const TRANSFER_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
transferSweepInterval = setInterval(() => {
  sweepExpiredTransfers(sql)
    .then((count) => {
      if (count > 0) log.info("expired transfers swept", { count });
    })
    .catch((err: unknown) =>
      log.error("transfer sweep failed", {
        err: err instanceof Error ? err.message : String(err),
      }),
    );
}, TRANSFER_SWEEP_INTERVAL_MS);

if (!process.env["RESEND_API_KEY"]) {
  log.warn("RESEND_API_KEY not set — verification emails will be logged to stdout instead of sent");
}
if (!process.env["TURNSTILE_SECRET_KEY"]) {
  log.warn("TURNSTILE_SECRET_KEY not set — CAPTCHA validation is disabled (dev mode)");
}
if (!process.env["APP_BASE_URL"]) {
  log.warn("APP_BASE_URL not set — defaulting to http://localhost:4000");
}
if (!process.env["POST_LOGIN_REDIRECT"]) {
  log.warn("POST_LOGIN_REDIRECT not set — defaulting to http://localhost:5174");
}

const rateLimiter = createRateLimiter();
const emailClient = createEmailClient();
const r2 = createR2Client();
if (!r2) log.warn("R2 not configured — upload endpoints will return 503");
const appBaseUrl = process.env["APP_BASE_URL"] ?? "http://localhost:4000";
const route = createRouter({ sql, rateLimiter, logger: log.child({ component: "central.routes" }), emailClient, appBaseUrl, r2, bootInfo });
const accessLogged = wrapWithAccessLog(route, {
  logger: log.child({ component: "central.access" }),
});

const server = Bun.serve({
  port: PORT,
  fetch: accessLogged,
});

log.info("central listening", { port: server.port });

// Graceful shutdown, bounded by a hard deadline so a hung pool drain
// (`sql.end()` never settling) can't wedge the process forever. See
// ./shutdown.ts for the deadline rationale.
function shutdown() {
  runShutdown({
    logger: log,
    clearTimers: () => {
      if (rotationInterval !== null) clearInterval(rotationInterval);
      if (transferSweepInterval !== null) clearInterval(transferSweepInterval);
    },
    stopServer: () => server.stop(),
    endDb: () => sql.end(),
    exit: (code) => process.exit(code),
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
