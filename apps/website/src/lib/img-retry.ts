// Retry-with-backoff helper for `<img>` elements that load assets from a
// freshly-provisioned runtime container. The runtime's HTTP server only
// becomes reachable after plugins finish spawning (runtime/src/main.ts step
// 6→7), and the user can land on the workspace before /icon is ready — a
// single onerror would otherwise lock the icon to the letter-avatar fallback
// for the entire session.
//
// The returned `srcWithCacheBuster` appends `?retry=N` so the browser issues a
// fresh HTTP request instead of replaying the cached failure.

import { createSignal, createEffect, onCleanup } from "solid-js";

const RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;

export interface ImgRetryHandle {
  /** Current src to bind to <img>. Includes a cache-buster on retries. */
  readonly srcWithCacheBuster: () => string;
  /** True once the resource has loaded successfully at least once. */
  readonly loaded: () => boolean;
  /** True once retries are exhausted — caller should fall back. */
  readonly exhausted: () => boolean;
  /** Bind to <img onLoad>. */
  readonly handleLoad: () => void;
  /** Bind to <img onError>. */
  readonly handleError: () => void;
}

/**
 * Reactive retry handle for an <img>. The retry counter and exhaustion flag
 * reset whenever `src()` changes (e.g. tunnel_url flips).
 */
export function useImgRetry(src: () => string | null): ImgRetryHandle {
  const [attempt, setAttempt] = createSignal(0);
  const [loaded, setLoaded] = createSignal(false);
  const [exhausted, setExhausted] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearPendingRetry(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  // Reset retry budget on src change (e.g. tunnel-url flip), but keep
  // `loaded` true if a previous src already loaded successfully — most src
  // changes (cache-buster bumps, tunnel-url flip from local to public) point
  // at the same underlying icon, and flickering to letter-avatar while the
  // new URL fetches reads as broken UI. Stale-while-revalidate: render the
  // last-known-good image until the new src either loads (stays good) or
  // exhausts retries (then we finally fall back). The first src for a
  // freshly-mounted helper still goes through the normal load path because
  // `loaded` defaults to false.
  createEffect(() => {
    src();
    clearPendingRetry();
    setAttempt(0);
    setExhausted(false);
    // Intentionally do NOT touch `loaded` here.
  });

  onCleanup(clearPendingRetry);

  const srcWithCacheBuster = (): string => {
    const base = src();
    if (base === null) return "";
    const n = attempt();
    if (n === 0) return base;
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}retry=${String(n)}`;
  };

  const handleLoad = (): void => {
    clearPendingRetry();
    setLoaded(true);
  };

  const handleError = (): void => {
    // Always step through the retry budget — even when a prior src loaded
    // successfully — so a permanently-broken new URL still falls back to the
    // letter avatar instead of pinning the stale image forever. The
    // stale-while-revalidate guarantee comes from leaving `loaded` true
    // *during* the retry sequence: the img element keeps painting the last
    // good image while we wait, and only flips to the letter when the
    // exhausted branch finally clears `loaded` below.
    const current = attempt();
    const delay = RETRY_DELAYS_MS[current];
    if (delay === undefined) {
      setExhausted(true);
      // Drop the stale-good flag at the same instant exhausted flips so the
      // consumer's `showLetter = !loaded || exhausted` evaluates cleanly to
      // letter-avatar. Without this, a consumer that gates only on `loaded`
      // would keep showing the stale image past exhaustion.
      setLoaded(false);
      return;
    }
    clearPendingRetry();
    timer = setTimeout(() => {
      timer = null;
      setAttempt(current + 1);
    }, delay);
  };

  return { srcWithCacheBuster, loaded, exhausted, handleLoad, handleError };
}
