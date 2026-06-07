import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  authHeaders,
  registerAndLogin,
  type TestServer,
} from "../test-helpers";

// Admin email must be set before startTestServer so the DB & router use it
process.env["ADMIN_EMAILS"] = "admin@example.com";

let ts: TestServer;
let adminToken: string;
let adminId: string;
let userToken: string;
let publisherId: string;

beforeAll(async () => {
  ts = await startTestServer();

  // Admin account — email matches ADMIN_EMAILS
  const admin = await registerAndLogin(ts, "admin");
  adminToken = admin.token;
  adminId = admin.accountId;

  // Regular non-admin account
  const user = await registerAndLogin(ts, "regular-user");
  userToken = user.token;
  publisherId = user.accountId;
});

afterAll(async () => {
  await ts.shutdown();
});

async function seedReport(overrides: {
  target_type?: string;
  status?: string;
  reason?: string;
  target_slug?: string;
}) {
  // Ensure a plugin exists for plugin reports
  let targetId: string;
  const targetType = overrides.target_type ?? "plugin";
  const targetSlug = overrides.target_slug ?? "admin-test-plugin";

  if (targetType === "plugin") {
    const existing = await ts.sql`SELECT id FROM plugins WHERE slug = ${targetSlug}`;
    if (existing[0]) {
      targetId = (existing[0] as { id: string }).id;
    } else {
      const rows = await ts.sql`
        INSERT INTO plugins (slug, name, description, publisher_id)
        VALUES (${targetSlug}, 'Admin Test Plugin', 'desc', ${publisherId})
        RETURNING id
      `;
      targetId = (rows[0] as { id: string }).id;
    }
  } else {
    // For server reports, use a fake UUID
    targetId = "00000000-0000-0000-0000-000000000001";
  }

  const rows = await ts.sql`
    INSERT INTO reports (reporter_id, target_type, target_id, target_slug, reason, status)
    VALUES (
      ${publisherId},
      ${targetType},
      ${targetId},
      ${targetSlug},
      ${overrides.reason ?? "other"},
      ${overrides.status ?? "pending"}
    )
    RETURNING id
  `;
  return (rows[0] as { id: string }).id;
}

describe("GET /v1/reports", () => {
  test("returns 403 for non-admin account", async () => {
    const res = await fetch(`${ts.url}/v1/reports`, {
      headers: authHeaders(userToken),
    });
    expect(res.status).toBe(403);
  });

  test("returns 401 without session", async () => {
    const res = await fetch(`${ts.url}/v1/reports`);
    expect(res.status).toBe(401);
  });

  test("returns 200 for admin with seeded reports", async () => {
    await seedReport({ status: "pending", target_slug: "admin-list-test" });

    const res = await fetch(`${ts.url}/v1/reports`, {
      headers: authHeaders(adminToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { reports: Record<string, unknown>[]; total: number };
    expect(Array.isArray(body.reports)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(body.total).toBeGreaterThan(0);

    const report = body.reports[0]!;
    expect(report.id).toBeDefined();
    expect(report.target_type).toBeDefined();
    expect(report.reason).toBeDefined();
    expect(report.status).toBeDefined();
    expect(report.reporter).toBeDefined();
    expect((report.reporter as Record<string, unknown>).display_name).toBeDefined();
  });

  test("filter status=pending returns only pending reports", async () => {
    await seedReport({ status: "pending", target_slug: "filter-status-pending" });
    await seedReport({ status: "dismissed", target_slug: "filter-status-dismissed" });

    const res = await fetch(`${ts.url}/v1/reports?status=pending`, {
      headers: authHeaders(adminToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { reports: Record<string, unknown>[] };
    expect(body.reports.every((r) => r.status === "pending")).toBe(true);
  });

  test("filter status=all returns reports of any status", async () => {
    const res = await fetch(`${ts.url}/v1/reports?status=all`, {
      headers: authHeaders(adminToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { reports: Record<string, unknown>[]; total: number };
    // Should include pending + dismissed seeded above
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  test("filter type=plugin returns only plugin reports", async () => {
    await seedReport({ target_type: "plugin", target_slug: "filter-type-plugin" });

    const res = await fetch(`${ts.url}/v1/reports?type=plugin&status=all`, {
      headers: authHeaders(adminToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { reports: Record<string, unknown>[] };
    expect(body.reports.every((r) => r.target_type === "plugin")).toBe(true);
  });

  test("filter type=server returns only server reports", async () => {
    await seedReport({ target_type: "server", target_slug: "filter-type-server" });

    const res = await fetch(`${ts.url}/v1/reports?type=server&status=all`, {
      headers: authHeaders(adminToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { reports: Record<string, unknown>[] };
    expect(body.reports.every((r) => r.target_type === "server")).toBe(true);
  });
});

describe("PATCH /v1/reports/:id", () => {
  let pendingReportId: string;

  beforeAll(async () => {
    pendingReportId = await seedReport({ status: "pending", target_slug: "resolve-test-plugin" });
  });

  test("returns 403 for non-admin account", async () => {
    const res = await fetch(`${ts.url}/v1/reports/${pendingReportId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders(userToken) },
      body: JSON.stringify({ status: "dismissed" }),
    });
    expect(res.status).toBe(403);
  });

  test("returns 401 without session", async () => {
    const res = await fetch(`${ts.url}/v1/reports/${pendingReportId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "dismissed" }),
    });
    expect(res.status).toBe(401);
  });

  test("returns 200 and updates status in DB", async () => {
    const reportId = await seedReport({ status: "pending", target_slug: "resolve-update-test" });

    const res = await fetch(`${ts.url}/v1/reports/${reportId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders(adminToken) },
      body: JSON.stringify({ status: "reviewed", reviewer_notes: "Looks legit" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("reviewed");
    expect(body.reviewer_notes).toBe("Looks legit");
    expect(body.reviewed_at).toBeDefined();

    // Verify in DB
    const rows = await ts.sql`SELECT status, reviewer_id FROM reports WHERE id = ${reportId}`;
    expect((rows[0] as { status: string }).status).toBe("reviewed");
    expect((rows[0] as { reviewer_id: string }).reviewer_id).toBe(adminId);
  });

  test("returns 400 for reviewer_notes exceeding length cap", async () => {
    const reportId = await seedReport({ status: "pending", target_slug: "resolve-long-notes" });

    const res = await fetch(`${ts.url}/v1/reports/${reportId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders(adminToken) },
      body: JSON.stringify({
        status: "reviewed",
        reviewer_notes: "x".repeat(2049),
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("2048 characters");
  });

  test("returns 400 when setting status=pending", async () => {
    const reportId = await seedReport({ status: "pending", target_slug: "resolve-back-to-pending" });

    const res = await fetch(`${ts.url}/v1/reports/${reportId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders(adminToken) },
      body: JSON.stringify({ status: "pending" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 for invalid status", async () => {
    const res = await fetch(`${ts.url}/v1/reports/${pendingReportId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders(adminToken) },
      body: JSON.stringify({ status: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 404 for unknown report id", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(`${ts.url}/v1/reports/${fakeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders(adminToken) },
      body: JSON.stringify({ status: "dismissed" }),
    });
    expect(res.status).toBe(404);
  });
});
