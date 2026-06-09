// Frontend panel bootstrap logic — proven without a browser.
//
// These cover the two DOM-wiring acceptance points deterministically:
//   - "iframe loads proxied HTML" → frame.src is set to the proxied URL the
//     runtime returns from the bootstrap POST.
//   - "Open in browser points to proxied URL" → link.href is always a /proxy/...
//     route, never the private upstream, even when the bootstrap POST fails
//     (the Safari/WebKit fallback path where the iframe cookie does not carry).

import { describe, expect, test } from "bun:test";
import { bootstrapFoundryPanel, proxiedMountUrl } from "../frontend/bootstrap.js";

const SLUG = "foundry-vtt";
const MOUNT = "foundry";
const PROXIED = `/proxy/${SLUG}/${MOUNT}/`;

interface El {
  src: string;
  href: string;
}
function el(): El {
  return { src: "", href: "" };
}

/** A fetch double that returns a 200 JSON body. */
function okFetch(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("proxiedMountUrl", () => {
  test("builds the runtime proxy route for a slug/mount pair", () => {
    expect(proxiedMountUrl(SLUG, MOUNT)).toBe(PROXIED);
  });
});

describe("bootstrapFoundryPanel", () => {
  test("on success sets the iframe src and link href to the proxied URL", async () => {
    const frame = el();
    const link = el();
    const url = await bootstrapFoundryPanel({
      fetchImpl: okFetch({ url: PROXIED }),
      token: "tok",
      frame,
      link,
      slug: SLUG,
      mount: MOUNT,
    });
    expect(url).toBe(PROXIED);
    expect(frame.src).toBe(PROXIED);
    expect(link.href).toBe(PROXIED);
  });

  test("sends a Bearer-authed same-origin POST to the bootstrap route", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      seenUrl = u;
      seenInit = init;
      return new Response(JSON.stringify({ url: PROXIED }), { status: 200 });
    }) as unknown as typeof fetch;

    await bootstrapFoundryPanel({ fetchImpl, token: "secret-token", frame: el(), link: el(), slug: SLUG, mount: MOUNT });

    expect(seenUrl).toBe(`/proxy-sessions/${SLUG}/${MOUNT}`);
    expect(seenInit).toBeDefined();
    const init = seenInit as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });

  test("pre-seeds the link with the proxied fallback before the POST resolves", async () => {
    const link = el();
    // A fetch that rejects: bootstrap fails, but the link must already point at
    // the proxied route so "Open in browser" still works (Safari/WebKit path).
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const url = await bootstrapFoundryPanel({
      fetchImpl: failing,
      token: "tok",
      frame: el(),
      link,
      slug: SLUG,
      mount: MOUNT,
    });
    expect(url).toBeNull();
    expect(link.href).toBe(PROXIED);
  });

  test("returns null and leaves the iframe untouched on a non-OK response", async () => {
    const frame = el();
    const link = el();
    const notOk = (async () => new Response("nope", { status: 409 })) as unknown as typeof fetch;

    const url = await bootstrapFoundryPanel({
      fetchImpl: notOk,
      token: "tok",
      frame,
      link,
      slug: SLUG,
      mount: MOUNT,
    });
    expect(url).toBeNull();
    expect(frame.src).toBe(""); // never navigated to a half-authed upstream
    expect(link.href).toBe(PROXIED); // fallback still usable
  });

  test("returns null when the response body lacks a url", async () => {
    const frame = el();
    const url = await bootstrapFoundryPanel({
      fetchImpl: okFetch({ notUrl: true }),
      token: "tok",
      frame,
      link: el(),
      slug: SLUG,
      mount: MOUNT,
    });
    expect(url).toBeNull();
    expect(frame.src).toBe("");
  });
});
