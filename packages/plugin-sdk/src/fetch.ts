// Outbound HTTP fetch — wraps the http.fetch IPC call.
//
// The runtime proxies the request from the server container; plugins cannot
// make network calls directly. Requires http.fetch:<hostname> in manifest.
//
// Security constraints enforced by the runtime:
//   - Only the declared hostnames are reachable
//   - Redirects are never followed (redirect: "manual")
//   - 30s timeout; 10MB response body cap
//   - Host, Cookie, and Authorization request headers are stripped

import type { createRequestClient } from "./request";
import type { IpcMessage } from "./transport";
import type { FetchOptions, FetchResponse } from "./types";
import { SdkError } from "./errors";
import { HttpFetchResult } from "./schemas";

export function createFetchApi(
  client: ReturnType<typeof createRequestClient>,
): { fetch(url: string, opts?: FetchOptions): Promise<FetchResponse> } {
  return {
    async fetch(url: string, opts?: FetchOptions): Promise<FetchResponse> {
      // Extract hostname so the runtime can scope-check the capability before
      // executing. The handler validates that url's actual hostname matches this.
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        throw new SdkError("invalid_url", `sdk.fetch: invalid URL "${url}"`, { url });
      }

      const msg: IpcMessage = {
        type: "http.fetch",
        url,
        host,
      };
      if (opts?.method !== undefined) msg["method"] = opts.method;
      if (opts?.headers !== undefined) msg["headers"] = opts.headers;
      if (opts?.body !== undefined) msg["body"] = opts.body;

      const r = await client.sendAndWait(HttpFetchResult, msg);

      // Decode base64 body lazily, caching across .text()/.json()/.bytes() calls.
      let cachedBytes: Uint8Array | undefined;
      let cachedText: string | undefined;

      function getBytes(): Uint8Array {
        if (cachedBytes !== undefined) return cachedBytes;
        const binary = atob(r.body);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          // charCodeAt is always 0–255 for binary strings produced by atob
          bytes[i] = binary.charCodeAt(i);
        }
        cachedBytes = bytes;
        return bytes;
      }

      function getText(): string {
        if (cachedText !== undefined) return cachedText;
        cachedText = new TextDecoder().decode(getBytes());
        return cachedText;
      }

      return {
        status: r.status,
        headers: r.headers,
        text: getText,
        json<T = unknown>(): T {
          return JSON.parse(getText()) as T;
        },
        bytes: getBytes,
      };
    },
  };
}
