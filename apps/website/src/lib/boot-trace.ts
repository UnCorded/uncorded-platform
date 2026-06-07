// First-entry tracing: comparable timelines for wizard-handoff vs page-refresh
// so we can diff WHERE a fresh-server entry diverges from a working
// hard-refresh entry. Only active when localStorage.boot_trace === "1" so
// production users never see the noise.
//
// Usage from DevTools console:
//   localStorage.boot_trace = "1"; location.reload();
//   // …reproduce both flows…
//   __bootTrace.dump()                         // one-off paste-friendly text
//   copy(JSON.stringify(__bootTrace.entries))  // full structured copy
//   __bootTrace.clear()                        // reset between runs
//
// Filter the raw stream in DevTools with prefix `[boot-trace]`.

interface TraceEntry {
  t: number;        // ms since boot trace start
  step: string;
  data?: Record<string, unknown> | undefined;
}

const ENABLED = (() => {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("boot_trace") === "1";
  } catch {
    return false;
  }
})();

const start = Date.now();
const entries: TraceEntry[] = [];

export function bootTrace(step: string, data?: Record<string, unknown>): void {
  if (!ENABLED) return;
  const t = Date.now() - start;
  const entry: TraceEntry = data === undefined ? { t, step } : { t, step, data };
  entries.push(entry);
  // eslint-disable-next-line no-console
  console.log(`[boot-trace] +${t}ms ${step}`, data ?? "");
}

function dump(): string {
  return entries
    .map((e) => `+${e.t}ms ${e.step}${e.data ? " " + JSON.stringify(e.data) : ""}`)
    .join("\n");
}

function clear(): void {
  entries.length = 0;
}

if (ENABLED && typeof window !== "undefined") {
  (window as unknown as { __bootTrace: unknown }).__bootTrace = {
    entries,
    dump,
    clear,
    enabled: true,
  };
}

export const bootTraceEnabled = ENABLED;
