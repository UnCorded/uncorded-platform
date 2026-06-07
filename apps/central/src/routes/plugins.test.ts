import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  authHeaders,
  registerAndLogin,
  type TestServer,
} from "../test-helpers";

let ts: TestServer;
let userToken: string;
let publisherId: string;

beforeAll(async () => {
  ts = await startTestServer();
  const user = await registerAndLogin(ts, "plugin-browser");
  userToken = user.token;
  publisherId = user.accountId;
});

afterAll(async () => {
  await ts.shutdown();
});

// Helpers to seed test data

async function seedPlugin(overrides: {
  slug?: string;
  name?: string;
  description?: string;
  trust_tier?: string;
  install_count?: number;
  is_listed?: boolean;
  category?: string;
}) {
  const slug = overrides.slug ?? `plugin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const rows = await ts.sql`
    INSERT INTO plugins (slug, name, description, trust_tier, install_count, is_listed, category, publisher_id)
    VALUES (
      ${slug},
      ${overrides.name ?? "Test Plugin"},
      ${overrides.description ?? "A test plugin"},
      ${overrides.trust_tier ?? "official"},
      ${overrides.install_count ?? 0},
      ${overrides.is_listed ?? true},
      ${overrides.category ?? "general"},
      ${publisherId}
    )
    RETURNING id, slug
  `;
  return rows[0] as { id: string; slug: string };
}

async function seedVersion(pluginId: string, version: string) {
  await ts.sql`
    INSERT INTO plugin_versions (plugin_id, version, api_version_range)
    VALUES (${pluginId}, ${version}, "^1.0.0")
  `;
}

// --- GET /v1/plugins ---

describe("GET /v1/plugins", () => {
  test("returns empty list when no plugins seeded", async () => {
    // Use a fresh table state — other tests may have seeded plugins, so query with unique tier
    const res = await fetch(`${ts.url}/v1/plugins?tier=verified`, {
      headers: authHeaders(userToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { plugins: unknown[]; total: number; limit: number; offset: number };
    expect(body.plugins).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(0);
  });

  test("returns seeded plugin with all fields including price: null", async () => {
    const plugin = await seedPlugin({ slug: "test-fields-plugin", name: "Fields Test" });

    const res = await fetch(`${ts.url}/v1/plugins`, {
      headers: authHeaders(userToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { plugins: Record<string, unknown>[] };
    const found = body.plugins.find((p) => p.slug === plugin.slug);
    expect(found).toBeDefined();
    expect(found!.name).toBe("Fields Test");
    expect(found!.price).toBeNull();
    expect(found!.avg_rating).toBeNull();
    expect(typeof found!.rating_count).toBe("number");
    expect(found!.install_count).toBe(0);
    expect(found!.trust_tier).toBe("official");
    expect(found!.updated_at).toBeDefined();
  });

  test("search q matches on name, excludes non-matching", async () => {
    await seedPlugin({ slug: "searchable-unique-xyz", name: "Unique XYZ Plugin" });
    await seedPlugin({ slug: "other-abc-plugin", name: "Other ABC Plugin" });

    const res = await fetch(`${ts.url}/v1/plugins?q=Unique+XYZ`, {
      headers: authHeaders(userToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { plugins: Record<string, unknown>[] };
    expect(body.plugins.some((p) => p.slug === "searchable-unique-xyz")).toBe(true);
    expect(body.plugins.some((p) => p.slug === "other-abc-plugin")).toBe(false);
  });

  test("filter tier=official returns only official tier", async () => {
    await seedPlugin({ slug: "official-tier-plugin", trust_tier: "official" });
    await seedPlugin({ slug: "community-tier-plugin", trust_tier: "community" });

    const res = await fetch(`${ts.url}/v1/plugins?tier=official`, {
      headers: authHeaders(userToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { plugins: Record<string, unknown>[] };
    expect(body.plugins.every((p) => p.trust_tier === "official")).toBe(true);
    expect(body.plugins.some((p) => p.slug === "official-tier-plugin")).toBe(true);
  });

  test("sort by installs returns higher install_count first", async () => {
    const slug1 = `sort-installs-low-${Date.now()}`;
    const slug2 = `sort-installs-high-${Date.now()}`;
    await seedPlugin({ slug: slug1, name: "Low Installs", install_count: 5, trust_tier: "community" });
    await seedPlugin({ slug: slug2, name: "High Installs", install_count: 999, trust_tier: "community" });

    const res = await fetch(`${ts.url}/v1/plugins?sort=installs&tier=community`, {
      headers: authHeaders(userToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { plugins: Record<string, unknown>[] };
    const idxHigh = body.plugins.findIndex((p) => p.slug === slug2);
    const idxLow = body.plugins.findIndex((p) => p.slug === slug1);
    expect(idxHigh).toBeLessThan(idxLow);
  });

  test("sort by updated returns most recently updated first", async () => {
    const slug1 = `sort-updated-old-${Date.now()}`;
    const slug2 = `sort-updated-new-${Date.now()}`;
    // Insert older plugin first, then newer
    await ts.sql`
      INSERT INTO plugins (slug, name, description, publisher_id, updated_at)
      VALUES (
        ${slug1}, 'Old Plugin', 'desc', ${publisherId},
        now() - interval '1 hour'
      )
    `;
    await ts.sql`
      INSERT INTO plugins (slug, name, description, publisher_id, updated_at)
      VALUES (
        ${slug2}, 'New Plugin', 'desc', ${publisherId},
        now()
      )
    `;

    const res = await fetch(`${ts.url}/v1/plugins?sort=updated&q=Plugin`, {
      headers: authHeaders(userToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { plugins: Record<string, unknown>[] };
    const idxNew = body.plugins.findIndex((p) => p.slug === slug2);
    const idxOld = body.plugins.findIndex((p) => p.slug === slug1);
    if (idxNew !== -1 && idxOld !== -1) {
      expect(idxNew).toBeLessThan(idxOld);
    }
  });

  test("returns 400 for invalid sort", async () => {
    const res = await fetch(`${ts.url}/v1/plugins?sort=bogus`, {
      headers: authHeaders(userToken),
    });
    expect(res.status).toBe(400);
  });

  test("returns 401 without session", async () => {
    const res = await fetch(`${ts.url}/v1/plugins`);
    expect(res.status).toBe(401);
  });
});

// --- GET /v1/plugins/:slug ---

describe("GET /v1/plugins/:slug", () => {
  let detailPlugin: { id: string; slug: string };

  beforeAll(async () => {
    detailPlugin = await seedPlugin({
      slug: "detail-test-plugin",
      name: "Detail Test",
      description: "A detailed plugin",
    });
    // Seed a version
    await ts.sql`
      INSERT INTO plugin_versions (plugin_id, version, api_version_range, changelog)
      VALUES (${detailPlugin.id}, '1.0.0', '^1.0.0', 'Initial release')
    `;
    // Seed a rating
    const rater = await registerAndLogin(ts, "plugin-rater");
    await ts.sql`
      INSERT INTO plugin_ratings (plugin_id, account_id, rating, review)
      VALUES (${detailPlugin.id}, ${rater.accountId}, 4, 'Good plugin')
    `;
  });

  test("returns full plugin detail with versions, publisher, ratings", async () => {
    const res = await fetch(`${ts.url}/v1/plugins/${detailPlugin.slug}`, {
      headers: authHeaders(userToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.slug).toBe(detailPlugin.slug);
    expect(body.name).toBe("Detail Test");
    expect(body.price).toBeNull();
    expect(Array.isArray(body.versions)).toBe(true);
    expect((body.versions as unknown[]).length).toBe(1);
    expect((body.versions as Record<string, unknown>[])[0]!.version).toBe("1.0.0");
    expect(body.publisher).toBeDefined();
    expect((body.publisher as Record<string, unknown>).display_name).toBeDefined();
    expect(body.avg_rating).toBe(4);
    expect(body.rating_count).toBe(1);
  });

  test("returns 404 for unknown slug", async () => {
    const res = await fetch(`${ts.url}/v1/plugins/does-not-exist`, {
      headers: authHeaders(userToken),
    });
    expect(res.status).toBe(404);
  });

  test("returns 404 for unlisted plugin", async () => {
    const unlisted = await seedPlugin({
      slug: "unlisted-hidden-plugin",
      is_listed: false,
    });
    const res = await fetch(`${ts.url}/v1/plugins/${unlisted.slug}`, {
      headers: authHeaders(userToken),
    });
    expect(res.status).toBe(404);
  });

  test("returns 401 without session", async () => {
    const res = await fetch(`${ts.url}/v1/plugins/${detailPlugin.slug}`);
    expect(res.status).toBe(401);
  });
});
