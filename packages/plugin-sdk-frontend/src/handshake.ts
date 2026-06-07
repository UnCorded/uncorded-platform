// Handshake — iframe sends uncorded.ready, waits for uncorded.token.
//
// Shell origin is derived from document.referrer (same approach as the admin panel).
// All inbound postMessages are origin-checked against this value.

import { SDK_API_VERSION } from "./version";

const HANDSHAKE_MESSAGE_TYPE = "uncorded.token";
const READY_MESSAGE_TYPE = "uncorded.ready";

export interface HandshakeResult {
  token: string;
  slug: string;
  /**
   * Runtime capabilities (e.g. `voice.media`) granted to this plugin by the
   * runtime. Sourced from the manifest after validation, so the shell — and
   * therefore the SDK consumer — sees the validated grant set, not the
   * declared one. Empty array if the shell omitted the field (older shells).
   */
  runtimeCapabilities: string[];
  /** The verified shell origin — used to validate all future inbound messages. */
  shellOrigin: string;
  initialNavigation?: { itemId: string; itemLabel: string } | undefined;
}

export function performHandshake(timeoutMs: number): Promise<HandshakeResult> {
  let shellOrigin: string;
  try {
    shellOrigin = new URL(document.referrer).origin;
  } catch {
    return Promise.reject(
      new Error(
        "Cannot determine shell origin: document.referrer is empty or invalid. " +
          "Is this plugin running inside an UnCorded shell?",
      ),
    );
  }

  return new Promise<HandshakeResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", listener);
      reject(
        new Error(
          `Handshake timed out after ${timeoutMs}ms: uncorded.ready was sent but no token was received. ` +
            "Is this plugin running inside an UnCorded shell?",
        ),
      );
    }, timeoutMs);

    function listener(event: MessageEvent): void {
      if (event.origin !== shellOrigin) return;

      const msg = event.data as Record<string, unknown> | null | undefined;
      if (!msg || msg["type"] !== HANDSHAKE_MESSAGE_TYPE) return;

      const token = msg["token"];
      const slug = msg["slug"];
      if (typeof token !== "string" || typeof slug !== "string") return;

      const rawCaps = msg["runtimeCapabilities"];
      const runtimeCapabilities = Array.isArray(rawCaps)
        ? rawCaps.filter((c): c is string => typeof c === "string")
        : [];

      const itemId = msg["itemId"] ?? msg["channelId"];
      const itemLabel = msg["itemLabel"] ?? msg["channelName"];
      const initialNavigation =
        typeof itemId === "string" && typeof itemLabel === "string"
          ? { itemId, itemLabel }
          : undefined;

      clearTimeout(timer);
      window.removeEventListener("message", listener);
      resolve({ token, slug, runtimeCapabilities, shellOrigin, initialNavigation });
    }

    window.addEventListener("message", listener);
    // Announce readiness — shell responds with uncorded.token. The SDK version
    // is included so the shell can detect a stale iframe HTML / SDK bundle
    // mismatch and trigger a hard reload of both before any plugin code runs.
    window.parent.postMessage(
      { type: READY_MESSAGE_TYPE, sdkApiVersion: SDK_API_VERSION },
      shellOrigin,
    );
  });
}
