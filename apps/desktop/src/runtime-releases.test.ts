// Coverage for the runtime-update discovery surface. Pure module — no
// Electron, no filesystem, just fetch + version math — so we exercise it
// directly via the `fetchImpl` injection seam.
//
// What's load-bearing here: this is the function the orchestrator calls to
// decide whether to flip update-state to `available`. A regression in the
// channel filter, the comparator, or the 404 short-circuit either causes a
// silent no-op (users never see updates) or a noisy false-positive (every
// fresh repo lights up the error pill).

import { describe, expect, test } from "bun:test";
import {
  matchesChannel,
  resolveLatestVersion,
  stripRuntimeTag,
} from "./runtime-releases";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function fetchReturning(response: Response): typeof fetch {
  return (async () => response) as unknown as typeof fetch;
}

function fetchThrowing(err: Error): typeof fetch {
  return (async () => {
    throw err;
  }) as unknown as typeof fetch;
}

describe("matchesChannel", () => {
  test("stable channel admits only plain X.Y.Z", () => {
    expect(matchesChannel("0.1.0", "stable")).toBe(true);
    expect(matchesChannel("1.10.3", "stable")).toBe(true);
    expect(matchesChannel("1.0.0-beta.1", "stable")).toBe(false);
    expect(matchesChannel("1.0.0-rc.1", "stable")).toBe(false);
    expect(matchesChannel("1.0.0-dev.1", "stable")).toBe(false);
  });

  test("beta channel admits stable + -beta.N (not -rc/-dev)", () => {
    expect(matchesChannel("1.0.0", "beta")).toBe(true);
    expect(matchesChannel("1.0.0-beta", "beta")).toBe(true);
    expect(matchesChannel("1.0.0-beta.3", "beta")).toBe(true);
    expect(matchesChannel("1.0.0-rc.1", "beta")).toBe(false);
    expect(matchesChannel("1.0.0-dev.1", "beta")).toBe(false);
  });

  test("dev channel admits everything that parses as a version", () => {
    expect(matchesChannel("1.0.0", "dev")).toBe(true);
    expect(matchesChannel("1.0.0-beta.1", "dev")).toBe(true);
    expect(matchesChannel("1.0.0-rc.1", "dev")).toBe(true);
    expect(matchesChannel("1.0.0-dev.1", "dev")).toBe(true);
    expect(matchesChannel("1.0.0-anything.42", "dev")).toBe(true);
  });

  test("garbage is rejected on every channel", () => {
    expect(matchesChannel("not-a-version", "dev")).toBe(false);
    expect(matchesChannel("1.0", "dev")).toBe(false);
    expect(matchesChannel("v1.0.0", "dev")).toBe(false);
    expect(matchesChannel("1.0.0.0", "dev")).toBe(false);
  });
});

describe("stripRuntimeTag", () => {
  test("strips runtime- prefix from valid tags", () => {
    expect(stripRuntimeTag("runtime-0.1.0")).toBe("0.1.0");
    expect(stripRuntimeTag("runtime-1.10.3-beta.2")).toBe("1.10.3-beta.2");
  });

  test("returns null for desktop-style tags", () => {
    // Desktop releases land on the same UnCorded/releases repo as `vX.Y.Z`;
    // the runtime filter must silently ignore them so the two streams don't
    // cross-talk. Regression here would surface desktop versions in the
    // runtime update pill.
    expect(stripRuntimeTag("v0.0.8")).toBeNull();
    expect(stripRuntimeTag("0.0.8")).toBeNull();
  });

  test("returns null for non-semver runtime tags", () => {
    expect(stripRuntimeTag("runtime-latest")).toBeNull();
    expect(stripRuntimeTag("runtime-1.0")).toBeNull();
    expect(stripRuntimeTag("runtime-")).toBeNull();
  });
});

describe("resolveLatestVersion", () => {
  test("404 short-circuits to null (no releases published yet)", async () => {
    // The fix-the-fresh-repo case — GitHub returns 404 on /releases when
    // a brand-new repo has nothing published. Treating it as up-to-date
    // keeps the panel clean instead of dumping a 404 body into the error
    // pill.
    const result = await resolveLatestVersion({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchReturning(
        new Response("{}", { status: 404, headers: { "content-type": "application/json" } }),
      ),
    });
    expect(result).toBeNull();
  });

  test("empty array returns null", async () => {
    const result = await resolveLatestVersion({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchReturning(jsonResponse([])),
    });
    expect(result).toBeNull();
  });

  test("returns the newest version greater than current", async () => {
    const result = await resolveLatestVersion({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchReturning(
        jsonResponse([
          { tag_name: "runtime-0.1.0", draft: false, prerelease: false },
          { tag_name: "runtime-0.2.0", draft: false, prerelease: false },
          { tag_name: "runtime-0.1.5", draft: false, prerelease: false },
        ]),
      ),
    });
    expect(result).toBe("0.2.0");
  });

  test("returns null when current is already at or above newest", async () => {
    const result = await resolveLatestVersion({
      channel: "stable",
      currentVersion: "0.2.0",
      fetchImpl: fetchReturning(
        jsonResponse([
          { tag_name: "runtime-0.1.0", draft: false, prerelease: false },
          { tag_name: "runtime-0.2.0", draft: false, prerelease: false },
        ]),
      ),
    });
    expect(result).toBeNull();
  });

  test("filters drafts (mirrors anonymous API behavior, defense in depth)", async () => {
    // Anonymous GitHub API listings already exclude drafts, but the code
    // also filters explicitly so an authenticated debug fetch won't surface
    // drafts to the orchestrator.
    const result = await resolveLatestVersion({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchReturning(
        jsonResponse([
          { tag_name: "runtime-0.2.0", draft: true, prerelease: false },
          { tag_name: "runtime-0.1.5", draft: false, prerelease: false },
        ]),
      ),
    });
    expect(result).toBe("0.1.5");
  });

  test("filters by channel: stable rejects beta tags", async () => {
    const result = await resolveLatestVersion({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchReturning(
        jsonResponse([
          { tag_name: "runtime-0.2.0-beta.1", draft: false, prerelease: true },
          { tag_name: "runtime-0.1.5", draft: false, prerelease: false },
        ]),
      ),
    });
    expect(result).toBe("0.1.5");
  });

  test("filters by channel: beta accepts both stable and -beta.N", async () => {
    const result = await resolveLatestVersion({
      channel: "beta",
      currentVersion: "0.1.0",
      fetchImpl: fetchReturning(
        jsonResponse([
          { tag_name: "runtime-0.2.0-beta.3", draft: false, prerelease: true },
          { tag_name: "runtime-0.1.5", draft: false, prerelease: false },
          { tag_name: "runtime-0.2.0-rc.1", draft: false, prerelease: true },
        ]),
      ),
    });
    // 0.2.0-beta.3 > 0.1.5 (main triple wins), and -rc.1 is filtered out.
    expect(result).toBe("0.2.0-beta.3");
  });

  test("filters by channel: dev accepts everything", async () => {
    const result = await resolveLatestVersion({
      channel: "dev",
      currentVersion: "0.1.0",
      fetchImpl: fetchReturning(
        jsonResponse([
          { tag_name: "runtime-0.2.0-dev.5", draft: false, prerelease: true },
          { tag_name: "runtime-0.1.5", draft: false, prerelease: false },
          { tag_name: "runtime-0.2.0-beta.1", draft: false, prerelease: true },
        ]),
      ),
    });
    // 0.2.0-dev.5 ordering vs 0.2.0-beta.1: alphanumeric "dev" > "beta"
    // by ASCII (semver §11.4.4). The newest on dev channel is dev.5.
    expect(result).toBe("0.2.0-dev.5");
  });

  test("ignores non-runtime tags (e.g. desktop vX.Y.Z)", async () => {
    const result = await resolveLatestVersion({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchReturning(
        jsonResponse([
          { tag_name: "v0.0.8", draft: false, prerelease: false }, // desktop, ignored
          { tag_name: "runtime-0.1.5", draft: false, prerelease: false },
        ]),
      ),
    });
    expect(result).toBe("0.1.5");
  });

  test("numeric (not lexicographic) sort: 1.10.0 > 1.9.0", async () => {
    const result = await resolveLatestVersion({
      channel: "stable",
      currentVersion: "1.0.0",
      fetchImpl: fetchReturning(
        jsonResponse([
          { tag_name: "runtime-1.9.0", draft: false, prerelease: false },
          { tag_name: "runtime-1.10.0", draft: false, prerelease: false },
        ]),
      ),
    });
    expect(result).toBe("1.10.0");
  });

  test("stable > prerelease at same main triple (semver §11.4)", async () => {
    const result = await resolveLatestVersion({
      channel: "dev",
      currentVersion: "0.9.0",
      fetchImpl: fetchReturning(
        jsonResponse([
          { tag_name: "runtime-1.0.0-beta.5", draft: false, prerelease: true },
          { tag_name: "runtime-1.0.0", draft: false, prerelease: false },
        ]),
      ),
    });
    expect(result).toBe("1.0.0");
  });

  test("non-200, non-404 response throws so caller surfaces error state", async () => {
    const fail = resolveLatestVersion({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchReturning(new Response("rate limited", { status: 403 })),
    });
    await expect(fail).rejects.toThrow(/GitHub Releases returned 403/);
  });

  test("non-JSON response throws", async () => {
    const fail = resolveLatestVersion({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchReturning(
        new Response("<!DOCTYPE html>not json", { status: 200 }),
      ),
    });
    await expect(fail).rejects.toThrow(/was not JSON/);
  });

  test("non-array JSON throws", async () => {
    const fail = resolveLatestVersion({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchReturning(jsonResponse({ message: "weird shape" })),
    });
    await expect(fail).rejects.toThrow(/was not an array/);
  });

  test("network failure surfaces with a useful message", async () => {
    const fail = resolveLatestVersion({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchThrowing(new Error("ECONNREFUSED")),
    });
    await expect(fail).rejects.toThrow(/GitHub Releases fetch failed.*ECONNREFUSED/);
  });
});
