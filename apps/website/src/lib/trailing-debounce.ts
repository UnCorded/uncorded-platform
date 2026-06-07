// Trailing-edge debouncer for coalescing bursts of high-frequency calls into a
// single trailing invocation. Used by the membership and permission stores to
// collapse rapid update storms; 100ms is small enough to feel instant after
// the user stops interacting.

export interface TrailingDebouncer<Args extends unknown[]> {
  fire(...args: Args): void;
  flush(): void;
  cancel(): void;
}

export interface DebouncerHooks {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export function createTrailingDebouncer<Args extends unknown[]>(
  fn: (...args: Args) => void,
  ms: number,
  hooks: DebouncerHooks = {
    setTimer: (cb, t) => setTimeout(cb, t),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): TrailingDebouncer<Args> {
  let timer: unknown = null;
  let pendingArgs: Args | null = null;

  return {
    fire(...args: Args) {
      pendingArgs = args;
      if (timer !== null) hooks.clearTimer(timer);
      timer = hooks.setTimer(() => {
        timer = null;
        const a = pendingArgs;
        pendingArgs = null;
        if (a) fn(...a);
      }, ms);
    },
    flush() {
      if (timer !== null) hooks.clearTimer(timer);
      timer = null;
      const a = pendingArgs;
      pendingArgs = null;
      if (a) fn(...a);
    },
    cancel() {
      if (timer !== null) hooks.clearTimer(timer);
      timer = null;
      pendingArgs = null;
    },
  };
}
