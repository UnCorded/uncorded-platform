// Frontend panel bootstrap logic — proven without a browser.
//
// These cover the DOM-wiring acceptance points deterministically against the
// blessed SDK surface (`sdk.proxy.openMount`), which the panel now uses instead
// of a hand-rolled fetch:
//   - "iframe loads proxied HTML" → frame.src is set to the iframeUrl the SDK
//     returns.
//   - "Open in browser points to the first-party handoff" → link.href is set to
//     the openUrl (the /proxy-open route), never the bare /proxy/ route, since
//     that would fail closed in Safari where the framed cookie is blocked.
//   - failure paths leave the iframe/link untouched and return null.

import { describe, expect, test } from "bun:test";
import { bootstrapFoundryPanel } from "../frontend/bootstrap.js";

const MOUNT = "foundry";
const IFRAME_URL = `/proxy/foundry-vtt/${MOUNT}/`;
const OPEN_URL = `/proxy-open/foundry-vtt/${MOUNT}?ticket=abc.def`;

interface El {
  src: string;
  href: string;
}
function el(): El {
  return { src: "", href: "" };
}

/** An openMount double that resolves with the given session. */
function okOpenMount(session: { iframeUrl: string; openUrl: string }) {
  return async (mount: string) => {
    expect(mount).toBe(MOUNT);
    return session;
  };
}

describe("bootstrapFoundryPanel", () => {
  test("on success sets the iframe src to iframeUrl and the link href to openUrl", async () => {
    const frame = el();
    const link = el();
    const session = await bootstrapFoundryPanel({
      openMount: okOpenMount({ iframeUrl: IFRAME_URL, openUrl: OPEN_URL }),
      frame,
      link,
      mount: MOUNT,
    });
    expect(session).toEqual({ iframeUrl: IFRAME_URL, openUrl: OPEN_URL });
    expect(frame.src).toBe(IFRAME_URL);
    // The fallback points at the first-party handoff, NOT the bare /proxy/ route.
    expect(link.href).toBe(OPEN_URL);
    expect(link.href.startsWith("/proxy-open/")).toBe(true);
  });

  test("calls openMount with the declared mount name", async () => {
    let seenMount = "";
    await bootstrapFoundryPanel({
      openMount: async (mount: string) => {
        seenMount = mount;
        return { iframeUrl: IFRAME_URL, openUrl: OPEN_URL };
      },
      frame: el(),
      link: el(),
      mount: MOUNT,
    });
    expect(seenMount).toBe(MOUNT);
  });

  test("returns null and leaves the iframe untouched when openMount rejects", async () => {
    const frame = el();
    const link = el();
    const session = await bootstrapFoundryPanel({
      openMount: async () => {
        throw new Error("PROXY_NOT_APPROVED");
      },
      frame,
      link,
      mount: MOUNT,
    });
    expect(session).toBeNull();
    expect(frame.src).toBe(""); // never navigated to a half-authed upstream
    expect(link.href).toBe(""); // no dead/unauthenticated fallback target
  });

  test("returns null when the session is missing a url field", async () => {
    const frame = el();
    const session = await bootstrapFoundryPanel({
      openMount: async () => ({ iframeUrl: IFRAME_URL }) as unknown as { iframeUrl: string; openUrl: string },
      frame,
      link: el(),
      mount: MOUNT,
    });
    expect(session).toBeNull();
    expect(frame.src).toBe("");
  });
});
