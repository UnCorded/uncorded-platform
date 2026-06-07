// Co-View viewer-side raw state debug panel (spec-27 PR-CV2 deliverable).
//
// This is intentionally NOT styled with the design system. The PR-CV2 spec
// gates the user-facing overlay shell behind PR-CV3+; this panel is the only
// way for an engineer to see that state sync is actually working end-to-end
// before the overlay exists. Mount it ONLY when `?co-view-debug=1` is in the
// URL — the assertion is "if you didn't ask for it, it doesn't render".
//
// What it shows:
//   - Current `lastSeq` and `awaitingSnapshot` flag.
//   - Pretty-printed shell-state snapshot.
//   - Tail of the event buffer (most-recent first).

import { For, Show, createMemo } from "solid-js";

import type { CoViewConsumer } from "./consumer";

export function CoViewDebugPanel(props: { consumer: CoViewConsumer }) {
  const snapshotJson = createMemo(() => JSON.stringify(props.consumer.snapshot(), null, 2));
  const recentEvents = createMemo(() => props.consumer.events().slice().reverse().slice(0, 20));

  return (
    <div
      style={{
        position: "fixed",
        bottom: "0",
        right: "0",
        width: "420px",
        "max-height": "60vh",
        overflow: "auto",
        background: "rgba(0, 0, 0, 0.85)",
        color: "#e5e7eb",
        "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
        "font-size": "12px",
        "line-height": "1.4",
        padding: "10px 12px",
        "border-top-left-radius": "8px",
        "z-index": "9999",
        "box-shadow": "0 -4px 16px rgba(0, 0, 0, 0.5)",
      }}
      data-testid="co-view-debug-panel"
    >
      <div style={{ "font-weight": "600", "margin-bottom": "6px" }}>
        co-view debug
      </div>
      <div style={{ "margin-bottom": "8px" }}>
        seq: <span style={{ color: "#7dd3fc" }}>{props.consumer.lastSeq()}</span>
        {" · "}
        awaiting:{" "}
        <span style={{ color: props.consumer.awaitingSnapshot() ? "#fde047" : "#86efac" }}>
          {props.consumer.awaitingSnapshot() ? "yes" : "no"}
        </span>
      </div>
      <details open>
        <summary style={{ cursor: "pointer", "user-select": "none" }}>snapshot</summary>
        <pre style={{ "white-space": "pre-wrap", "word-break": "break-word", margin: "4px 0 8px 0" }}>
          {snapshotJson()}
        </pre>
      </details>
      <details>
        <summary style={{ cursor: "pointer", "user-select": "none" }}>
          events ({props.consumer.events().length})
        </summary>
        <Show when={recentEvents().length > 0} fallback={<div style={{ opacity: "0.6" }}>none</div>}>
          <For each={recentEvents()}>
            {(ev) => (
              <div style={{ "border-bottom": "1px solid #374151", padding: "4px 0" }}>
                <div style={{ color: "#a78bfa" }}>
                  {ev.frame.kind} <span style={{ opacity: "0.6" }}>({ev.frame.replay})</span>
                </div>
                <pre style={{ "white-space": "pre-wrap", "word-break": "break-word", margin: 0 }}>
                  {JSON.stringify(ev.frame.payload, null, 2)}
                </pre>
              </div>
            )}
          </For>
        </Show>
      </details>
    </div>
  );
}
