import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  registerAndLogin,
  authHeaders,
  type TestServer,
} from "../test-helpers";
import { createRouter } from "../routes";
import { createLogger } from "@uncorded/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "test-plugin",
    version: "1.0.0",
    api_version: "^1.0",
    author: "Test Author",
    description: "A test plugin",
    type: "standalone",
    permissions: ["runtime.log"],
    backend: { entry: "index.ts" },
    ...overrides,
  };
}

/** Publish-time validation requires a real zip magic header (PK\x03\x04).
 *  This minimal buffer passes the header check; the remaining bytes are
 *  opaque filler that gets buffered, hashed, and handed to the mock R2. */
function makeMinimalZip(): Blob {
  const header = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03, 0x04);
  return new Blob([header], { type: "application/zip" });
}

function makeFormData(manifest: Record<string, unknown>, opts?: {
  description?: string;
  long_description?: string;
  category?: string;
  trust_tier?: string;
  package?: Blob;
}): FormData {
  const form = new FormData();
  form.append("manifest", JSON.stringify(manifest));
  form.append("package", opts?.package ?? makeMinimalZip(), "package.zip");
  form.append("description", opts?.description ?? "A test plugin description");
  if (opts?.long_description !== undefined) form.append("long_description", opts.long_description);
  if (opts?.category !== undefined) form.append("category", opts.category);
  if (opts?.trust_tier !== undefined) form.append("trust_tier", opts.trust_tier);
  return form;
}

function makeVersionForm(version: string, apiVersionRange = "^1.0", opts?: { package?: Blob }): FormData {
  const form = new FormData();
  form.append("version", version);
  form.append("api_version_range", apiVersionRange);
  form.append("package", opts?.package ?? makeMinimalZip(), "package.zip");
  return form;
}

// ---------------------------------------------------------------------------
// POST /v1/plugins
// ---------------------------------------------------------------------------

describe("POST /v1/plugins", () => {
  let ts: TestServer;
  let r2NullUrl: string;
  let r2NullServer: ReturnType<typeof Bun.serve>;
  let adminToken: string;
  let adminEmail: string;
  let userToken: string;
  const origAdminEmails = process.env["ADMIN_EMAILS"];

  beforeAll(async () => {
    ts = await startTestServer();
    ({ token: adminToken } = await registerAndLogin(ts, "publish-admin"));
    adminEmail = "publish-admin@example.com";
    ({ token: userToken } = await registerAndLogin(ts, "publish-user"));

    // Second server sharing same DB, r2: null — for 503 tests
    const r2NullRoute = createRouter({
      sql: ts.sql,
      rateLimiter: { consume() { return { allowed: true, retryAfter: 0 }; }, resetForTests() {} },
      logger: createLogger({ component: "test-publish-r2null" }),
      emailClient: null,
      appBaseUrl: "http://localhost:4000",
      r2: null,
      bootInfo: { version: "test", commit: "test", startedAt: Date.now() },
    });
    r2NullServer = Bun.serve({ port: 0, fetch: r2NullRoute });
    r2NullUrl = `http://localhost:${r2NullServer.port}`;
  });

  afterAll(async () => {
    process.env["ADMIN_EMAILS"] = origAdminEmails;
    r2NullServer.stop();
    await ts.shutdown();
  });

  test("201 valid admin publishes plugin (defaults to community tier)", async () => {
    process.env["ADMIN_EMAILS"] = adminEmail;
    const res = await fetch(`${ts.url}/v1/plugins`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: makeFormData(makeManifest({ name: "valid-plugin" })),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.slug).toBe("valid-plugin");
    expect(body.trust_tier).toBe("community");
    expect(body.latest_version).toBe("1.0.0");
  });

  test("201 admin can opt plugin into official tier at publish time", async () => {
    process.env["ADMIN_EMAILS"] = adminEmail;
    const res = await fetch(`${ts.url}/v1/plugins`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: makeFormData(makeManifest({ name: "official-plugin" }), { trust_tier: "official" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.trust_tier).toBe("official");
  });

  test("400 rejects non-zip package (missing magic header)", async () => {
    process.env["ADMIN_EMAILS"] = adminEmail;
    const badPackage = new Blob(["not-a-zip"], { type: "application/zip" });
    const res = await fetch(`${ts.url}/v1/plugins`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: makeFormData(makeManifest({ name: "bad-package-plugin" }), { package: badPackage }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("PACKAGE_INVALID_FORMAT");
  });

  // NOTE: the size cap itself is exercised as a unit test against
  // validatePackageUpload in plugin-package.test.ts — constructing a real
  // 10 MB multipart body just to prove the cap fires would cost seconds per
  // test run for no coverage gain the unit test doesn't already provide.

  test("403 non-admin cannot publish plugin", async () => {
    process.env["ADMIN_EMAILS"] = adminEmail;
    const res = await fetch(`${ts.url}/v1/plugins`, {
      method: "POST",
      headers: authHeaders(userToken),
      body: makeFormData(makeManifest({ name: "forbidden-plugin" })),
    });
    expect(res.status).toBe(403);
  });

  test("409 duplicate slug", async () => {
    process.env["ADMIN_EMAILS"] = adminEmail;
    await fetch(`${ts.url}/v1/plugins`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: makeFormData(makeManifest({ name: "dup-slug-plugin" })),
    });
    const res = await fetch(`${ts.url}/v1/plugins`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: makeFormData(makeManifest({ name: "dup-slug-plugin" })),
    });
    expect(res.status).toBe(409);
  });

  test("400 bad manifest (missing required fields)", async () => {
    process.env["ADMIN_EMAILS"] = adminEmail;
    const res = await fetch(`${ts.url}/v1/plugins`, {
      method: "POST",
      headers: authHeaders(adminToken),
      // Missing version, author, type, permissions, entry point
      body: makeFormData({ name: "bad-manifest" }),
    });
    expect(res.status).toBe(400);
  });

  test("503 when r2 is null", async () => {
    process.env["ADMIN_EMAILS"] = adminEmail;
    const res = await fetch(`${r2NullUrl}/v1/plugins`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: makeFormData(makeManifest({ name: "r2-null-plugin" })),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("R2_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// POST /v1/plugins/:slug/versions
// ---------------------------------------------------------------------------

describe("POST /v1/plugins/:slug/versions", () => {
  let ts: TestServer;
  let r2NullUrl: string;
  let r2NullServer: ReturnType<typeof Bun.serve>;
  let adminToken: string;
  let adminEmail: string;
  let seededSlug: string;
  let seededSlugForR2Null: string;
  const origAdminEmails = process.env["ADMIN_EMAILS"];

  beforeAll(async () => {
    ts = await startTestServer();
    ({ token: adminToken } = await registerAndLogin(ts, "version-admin"));
    adminEmail = "version-admin@example.com";
    process.env["ADMIN_EMAILS"] = adminEmail;

    const accountRows = await ts.sql`SELECT id FROM accounts WHERE email = ${adminEmail} LIMIT 1`;
    const publisherId = (accountRows[0] as { id: string }).id;

    // Seed a plugin for normal version tests
    seededSlug = "seeded-for-versions";
    const rows = await ts.sql`
      INSERT INTO plugins (slug, name, description, category, trust_tier, publisher_id, latest_version, is_listed)
      VALUES (${seededSlug}, ${seededSlug}, 'desc', 'general', 'official', ${publisherId}, '1.0.0', true)
      RETURNING id
    `;
    const seededPluginId = (rows[0] as { id: string }).id;
    await ts.sql`
      INSERT INTO plugin_versions (plugin_id, version, api_version_range, package_url)
      VALUES (${seededPluginId}, '1.0.0', '^1.0', ${"plugins/" + seededSlug + "/1.0.0/package.zip"})
    `;

    // Seed a plugin for the 503 test
    seededSlugForR2Null = "seeded-for-r2-null-versions";
    await ts.sql`
      INSERT INTO plugins (slug, name, description, category, trust_tier, publisher_id, latest_version, is_listed)
      VALUES (${seededSlugForR2Null}, ${seededSlugForR2Null}, 'desc', 'general', 'official', ${publisherId}, '1.0.0', true)
    `;

    // Second server sharing same DB, r2: null
    const r2NullRoute = createRouter({
      sql: ts.sql,
      rateLimiter: { consume() { return { allowed: true, retryAfter: 0 }; }, resetForTests() {} },
      logger: createLogger({ component: "test-version-r2null" }),
      emailClient: null,
      appBaseUrl: "http://localhost:4000",
      r2: null,
      bootInfo: { version: "test", commit: "test", startedAt: Date.now() },
    });
    r2NullServer = Bun.serve({ port: 0, fetch: r2NullRoute });
    r2NullUrl = `http://localhost:${r2NullServer.port}`;
  });

  afterAll(async () => {
    process.env["ADMIN_EMAILS"] = origAdminEmails;
    r2NullServer.stop();
    await ts.shutdown();
  });

  test("201 valid new version", async () => {
    const res = await fetch(`${ts.url}/v1/plugins/${seededSlug}/versions`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: makeVersionForm("1.1.0"),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.version).toBe("1.1.0");
  });

  test("404 unknown slug", async () => {
    const res = await fetch(`${ts.url}/v1/plugins/no-such-plugin/versions`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: makeVersionForm("1.0.0"),
    });
    expect(res.status).toBe(404);
  });

  test("409 duplicate version", async () => {
    await fetch(`${ts.url}/v1/plugins/${seededSlug}/versions`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: makeVersionForm("2.0.0"),
    });
    const res = await fetch(`${ts.url}/v1/plugins/${seededSlug}/versions`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: makeVersionForm("2.0.0"),
    });
    expect(res.status).toBe(409);
  });

  test("503 when r2 is null", async () => {
    const res = await fetch(`${r2NullUrl}/v1/plugins/${seededSlugForR2Null}/versions`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: makeVersionForm("1.1.0"),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("R2_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// GET /v1/plugins/:slug/download
// ---------------------------------------------------------------------------

describe("GET /v1/plugins/:slug/download", () => {
  let ts: TestServer;
  let r2NullUrl: string;
  let r2NullServer: ReturnType<typeof Bun.serve>;
  let token: string;
  let downloadSlug: string;
  const origAdminEmails = process.env["ADMIN_EMAILS"];

  beforeAll(async () => {
    ts = await startTestServer();
    ({ token } = await registerAndLogin(ts, "download-user"));

    const accountRows = await ts.sql`SELECT id FROM accounts WHERE email = 'download-user@example.com' LIMIT 1`;
    const publisherId = (accountRows[0] as { id: string }).id;

    downloadSlug = "download-test-plugin";
    const pluginRows = await ts.sql`
      INSERT INTO plugins (slug, name, description, category, trust_tier, publisher_id, latest_version, is_listed)
      VALUES (${downloadSlug}, ${downloadSlug}, 'desc', 'general', 'official', ${publisherId}, '1.0.0', true)
      RETURNING id
    `;
    const pluginId = (pluginRows[0] as { id: string }).id;
    const fixtureHash = "a".repeat(64);
    await ts.sql`
      INSERT INTO plugin_versions (plugin_id, version, api_version_range, package_url, package_size_bytes, package_sha256)
      VALUES (${pluginId}, '1.0.0', '^1.0', ${"plugins/" + downloadSlug + "/1.0.0/package.zip"}, 42, ${fixtureHash})
    `;

    // Second server with r2: null
    const r2NullRoute = createRouter({
      sql: ts.sql,
      rateLimiter: { consume() { return { allowed: true, retryAfter: 0 }; }, resetForTests() {} },
      logger: createLogger({ component: "test-download-r2null" }),
      emailClient: null,
      appBaseUrl: "http://localhost:4000",
      r2: null,
      bootInfo: { version: "test", commit: "test", startedAt: Date.now() },
    });
    r2NullServer = Bun.serve({ port: 0, fetch: r2NullRoute });
    r2NullUrl = `http://localhost:${r2NullServer.port}`;
  });

  afterAll(async () => {
    process.env["ADMIN_EMAILS"] = origAdminEmails;
    r2NullServer.stop();
    await ts.shutdown();
  });

  test("200 returns signed URL with integrity metadata", async () => {
    const res = await fetch(`${ts.url}/v1/plugins/${downloadSlug}/download`, {
      method: "GET",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      version: string;
      url: string;
      sha256: string | null;
      size_bytes: number | null;
      expires_in: number;
    };
    expect(body.url).toBe("https://r2.example.com/mock-get");
    expect(body.version).toBe("1.0.0");
    // Runtime MUST verify this hash against downloaded bytes.
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.size_bytes).toBe(42);
    expect(body.expires_in).toBe(900);
  });

  test("404 unknown slug", async () => {
    const res = await fetch(`${ts.url}/v1/plugins/no-such-plugin/download`, {
      method: "GET",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
  });

  test("503 when r2 is null", async () => {
    const res = await fetch(`${r2NullUrl}/v1/plugins/${downloadSlug}/download`, {
      method: "GET",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("R2_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// POST /v1/auth/avatar/upload-url
// ---------------------------------------------------------------------------

describe("POST /v1/auth/avatar/upload-url", () => {
  let ts: TestServer;
  let r2NullUrl: string;
  let r2NullServer: ReturnType<typeof Bun.serve>;
  let token: string;

  beforeAll(async () => {
    ts = await startTestServer();
    ({ token } = await registerAndLogin(ts, "avatar-user"));

    // Second server with r2: null
    const r2NullRoute = createRouter({
      sql: ts.sql,
      rateLimiter: { consume() { return { allowed: true, retryAfter: 0 }; }, resetForTests() {} },
      logger: createLogger({ component: "test-avatar-r2null" }),
      emailClient: null,
      appBaseUrl: "http://localhost:4000",
      r2: null,
      bootInfo: { version: "test", commit: "test", startedAt: Date.now() },
    });
    r2NullServer = Bun.serve({ port: 0, fetch: r2NullRoute });
    r2NullUrl = `http://localhost:${r2NullServer.port}`;
  });

  afterAll(async () => {
    r2NullServer.stop();
    await ts.shutdown();
  });

  test("200 returns presigned-POST envelope with size cap", async () => {
    const res = await fetch(`${ts.url}/v1/auth/avatar/upload-url`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: "image/png" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.upload_url).toBe("string");
    expect(typeof body.final_url).toBe("string");
    expect(body.expires_in).toBe(300);
    // Presigned POST replaced presigned PUT so R2 enforces a content-length-range
    // policy condition. The shell uploads via FormData built from upload_fields,
    // and the size cap means a leaked URL can't be used to dump GBs into R2.
    expect(body.upload_fields).toMatchObject({ "Content-Type": "image/png" });
    expect(body.max_bytes).toBe(5 * 1024 * 1024);
  });

  test("400 bad content_type", async () => {
    const res = await fetch(`${ts.url}/v1/auth/avatar/upload-url`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: "text/plain" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_CONTENT_TYPE");
  });

  test("503 when r2 is null", async () => {
    const res = await fetch(`${r2NullUrl}/v1/auth/avatar/upload-url`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: "image/jpeg" }),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("R2_UNAVAILABLE");
  });
});
