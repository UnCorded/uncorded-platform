import type { Sql } from "../db";

export interface BootInfo {
  readonly version: string;
  readonly commit: string;
  readonly startedAt: number;
}

// Tight cap so /health can never queue behind a slow DB. Load balancers and
// healthcheck pollers hit this constantly; if Postgres goes sideways we want
// the endpoint to fail fast (503) rather than tie up workers.
const DB_PING_TIMEOUT_MS = 250;

export async function handleHealth(sql: Sql, boot: BootInfo): Promise<Response> {
  const uptimeS = Math.max(0, Math.floor((Date.now() - boot.startedAt) / 1000));

  const dbStart = Date.now();
  let dbState: "ok" | "down" = "down";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("db ping timeout")),
        DB_PING_TIMEOUT_MS,
      );
    });
    await Promise.race([sql`SELECT 1`, timeout]);
    dbState = "ok";
  } catch {
    // Generic state only — /health is publicly reachable and we never want
    // driver error strings (which can include connection metadata) on the wire.
    dbState = "down";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const dbLatencyMs = Date.now() - dbStart;

  const ok = dbState === "ok";
  const body = {
    status: ok ? "ok" : "degraded",
    version: boot.version,
    commit: boot.commit,
    uptime_s: uptimeS,
    db: { state: dbState, latency_ms: dbLatencyMs },
  };
  return Response.json(body, { status: ok ? 200 : 503 });
}
