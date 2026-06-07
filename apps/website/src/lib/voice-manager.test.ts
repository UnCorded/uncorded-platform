// Voice manager — Bun smoke tests (5c).
//
// Scope: the §13 rows that are reachable without a real LiveKit cluster or a
// browser harness. Specifically:
//
//   - singleton cardinality (§13 last row, §15 pin #7)
//   - `voice.media` cap-gate rejection (§13 row 3, §1)
//   - cross-server filter on snapshotFor (§3 / pin #3)
//   - subscribe() no longer fires an initial snapshot (regression for the
//     fresh-mount race fixed in 5c-prep)
//
// Rows that DO need a real LiveKit + multi-context Playwright (mid-call ban,
// identity collision, cross-server reconnect, token-refresh past 5min, mic
// permission denial) are deferred — see contract §13 and the sub-commit table.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

// `getPluginRuntimeCapabilities` is the only thing voice-manager imports from
// the sidebar store — mock JUST that and spread the real module so any sibling
// test that loads sidebar afterwards still sees a complete surface (guards
// against the mock.module namespace-leak hazard documented in CLAUDE memory).
let runtimeCapsBySlug: Record<string, string[]> = {};

let manager: typeof import("./voice-manager");

beforeAll(async () => {
  const realSidebar = await import("@/stores/sidebar");
  // Spread into a plain object at import time — `import * as X` would be a
  // live binding and the mock factory would race.
  const realSidebarSnapshot = { ...realSidebar };
  await mock.module("@/stores/sidebar", () => ({
    ...realSidebarSnapshot,
    getPluginRuntimeCapabilities: (slug: string) => runtimeCapsBySlug[slug] ?? [],
  }));
  manager = await import("./voice-manager");
});

beforeEach(() => {
  runtimeCapsBySlug = {};
});

afterAll(() => {
  // Best-effort: clear any subscribers a test left registered. The exported
  // subscribe() returns its own unsubscribe; tests below clean up explicitly,
  // but keep this as a defense against future additions forgetting to.
});

describe("singleton cardinality (§15 pin #7)", () => {
  test("re-importing voice-manager returns the same module instance", async () => {
    const second = await import("./voice-manager");
    expect(second).toBe(manager);
    // Public reactive accessors are the same function references — proves the
    // signals weren't reconstructed by a second createRoot.
    expect(second.state).toBe(manager.state);
    expect(second.participants).toBe(manager.participants);
    expect(second.activeSpeakerIds).toBe(manager.activeSpeakerIds);
  });
});

describe("voice.media cap-gate (§1, §13 row 3)", () => {
  test("connect short-circuits when the plugin lacks voice.media", async () => {
    runtimeCapsBySlug = { "voice-channels": [] };

    const received: import("@uncorded/plugin-sdk-frontend").VoiceEnvelope[] = [];
    const unsubscribe = manager.subscribe("srv-A", "voice-channels", (env) => {
      received.push(env);
    });

    await manager.connect({
      serverId: "srv-A",
      slug: "voice-channels",
      channelId: "ch-1",
      channelName: "general",
    });

    const s = manager.state();
    expect(s.status).toBe("failed");
    expect(s.reason).toBe("voice_media_not_granted");
    expect(s.error?.code).toBe("voice_media_not_granted");
    expect(s.serverId).toBe("srv-A");
    expect(s.channelId).toBe("ch-1");
    expect(s.channelName).toBe("general");

    // The subscriber must have observed BOTH a state-failed push AND the
    // dedicated error envelope (§3d) — plugins surface the error toast from
    // the latter even when state.failed is enough to swap the CTA.
    const stateEnvs = received.filter((e) => e.type === "platform.voice.state");
    const errorEnvs = received.filter((e) => e.type === "platform.voice.error");
    expect(stateEnvs.length).toBeGreaterThanOrEqual(1);
    expect(errorEnvs.length).toBe(1);
    expect(errorEnvs[0]).toMatchObject({
      type: "platform.voice.error",
      code: "voice_media_not_granted",
    });

    unsubscribe();
    await manager.disconnect();
  });

  // The positive-path "connect proceeds when voice.media is granted" test is
  // intentionally NOT here — it would await the dynamic `livekit-client`
  // import which hangs in Bun's test env (no Vite chunk resolution) and the
  // path past the cap check needs a real LiveKit cluster anyway. That row
  // belongs to the deferred Playwright tier (§13 last paragraph).
});

describe("snapshotFor cross-server filter (§3, pin #3)", () => {
  test("emits only a state envelope (no participants/speakers) when not connected to that serverId", () => {
    // After the disconnect()s above, manager state is disconnected with
    // serverId === null. snapshotFor must:
    //   - Always push a `platform.voice.state` envelope tagged with the
    //     iframe's own server provisioned flag — server-scoped, not
    //     session-scoped, so it's not a cross-server leak. Voice plugins
    //     need this to render their dimmed/lit sidebar item even before
    //     anyone has connected to a session.
    //   - Skip participants/active-speakers entirely (those ARE session-
    //     scoped and would constitute a pin #3 leak).
    const captured: unknown[] = [];
    manager.snapshotFor("srv-X", (env) => captured.push(env));
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      type: "platform.voice.state",
      serverId: null,
    });
  });
});

describe("screen-share slot reservations (PR-6 §3 row 4, edge cases 16/27/32)", () => {
  // Slot map drives the shell-side overlay portal. The test scope here is the
  // pure bookkeeping path — register/update/unregister + the per-frame sweep —
  // exercised through the public exports without a real iframe wired up.
  // The reactive accessor `screenShareSlots$` makes the result observable.
  //
  // Stub iframe — these bookkeeping tests don't read getBoundingClientRect,
  // so a unique sentinel object per logical frame exercises the data model
  // without standing up a DOM. Kept stable per logical frame so identity
  // assertions on the entry would also work.
  const stubIframe = (id: string): HTMLIFrameElement =>
    ({ __testId: id }) as unknown as HTMLIFrameElement;

  test("registerScreenSlot adds a slot visible via screenShareSlots$", () => {
    const before = manager.screenShareSlots$();
    const iframe = stubIframe("frame-A");
    manager.registerScreenSlot({
      frameKey: "frame-A",
      iframe,
      slotId: "slot-1",
      trackSid: "TR_1",
      rect: { x: 10, y: 20, width: 320, height: 180 },
    });
    const after = manager.screenShareSlots$();
    expect(after.length).toBe(before.length + 1);
    const added = after.find(
      (s) => s.frameKey === "frame-A" && s.slotId === "slot-1",
    );
    expect(added).toBeDefined();
    expect(added?.trackSid).toBe("TR_1");
    expect(added?.iframe).toBe(iframe);
    expect(added?.rect).toEqual({ x: 10, y: 20, width: 320, height: 180 });
    manager.unregisterScreenSlot({ frameKey: "frame-A", slotId: "slot-1" });
  });

  test("updateScreenSlot is a no-op when rect is unchanged (signal does not churn)", () => {
    manager.registerScreenSlot({
      frameKey: "frame-coalesce",
      iframe: stubIframe("frame-coalesce"),
      slotId: "slot-1",
      trackSid: "TR_2",
      rect: { x: 0, y: 0, width: 100, height: 50 },
    });
    const reference = manager.screenShareSlots$();

    manager.updateScreenSlot({
      frameKey: "frame-coalesce",
      slotId: "slot-1",
      rect: { x: 0, y: 0, width: 100, height: 50 },
    });
    const afterNoOp = manager.screenShareSlots$();
    // Signal value should be the same reference because publishSlotsSignal
    // was not called — rect equality short-circuits the update.
    expect(afterNoOp).toBe(reference);

    manager.updateScreenSlot({
      frameKey: "frame-coalesce",
      slotId: "slot-1",
      rect: { x: 5, y: 0, width: 100, height: 50 },
    });
    const afterChange = manager.screenShareSlots$();
    expect(afterChange).not.toBe(reference);
    const updated = afterChange.find(
      (s) => s.frameKey === "frame-coalesce" && s.slotId === "slot-1",
    );
    expect(updated?.rect.x).toBe(5);

    manager.unregisterScreenSlot({
      frameKey: "frame-coalesce",
      slotId: "slot-1",
    });
  });

  test("updateScreenSlot for an unknown slot is a silent no-op (no auto-register)", () => {
    const before = manager.screenShareSlots$();
    manager.updateScreenSlot({
      frameKey: "frame-ghost",
      slotId: "slot-ghost",
      rect: { x: 1, y: 2, width: 3, height: 4 },
    });
    const after = manager.screenShareSlots$();
    // Same reference — nothing was added or signaled.
    expect(after).toBe(before);
  });

  test("unregisterScreenSlotsForFrame drops only the matching frame's slots", () => {
    manager.registerScreenSlot({
      frameKey: "frame-stay",
      iframe: stubIframe("frame-stay"),
      slotId: "slot-keep",
      trackSid: "TR_3",
      rect: { x: 0, y: 0, width: 1, height: 1 },
    });
    const goIframe = stubIframe("frame-go");
    manager.registerScreenSlot({
      frameKey: "frame-go",
      iframe: goIframe,
      slotId: "slot-drop-1",
      trackSid: "TR_4",
      rect: { x: 0, y: 0, width: 1, height: 1 },
    });
    manager.registerScreenSlot({
      frameKey: "frame-go",
      iframe: goIframe,
      slotId: "slot-drop-2",
      trackSid: "TR_5",
      rect: { x: 0, y: 0, width: 1, height: 1 },
    });

    manager.unregisterScreenSlotsForFrame("frame-go");
    const remaining = manager.screenShareSlots$();
    expect(remaining.find((s) => s.frameKey === "frame-go")).toBeUndefined();
    expect(
      remaining.find(
        (s) => s.frameKey === "frame-stay" && s.slotId === "slot-keep",
      ),
    ).toBeDefined();

    manager.unregisterScreenSlot({
      frameKey: "frame-stay",
      slotId: "slot-keep",
    });
  });

  test("two iframes can register the same slotId without collision (split-panel mount)", () => {
    // Edge case 27: two mounts of voice-channels in different panels each
    // hold their own frameKey, so identical slotIds must NOT shadow each
    // other in the slot map.
    const leftIframe = stubIframe("frame-left");
    const rightIframe = stubIframe("frame-right");
    manager.registerScreenSlot({
      frameKey: "frame-left",
      iframe: leftIframe,
      slotId: "slot-1",
      trackSid: "TR_left",
      rect: { x: 0, y: 0, width: 10, height: 10 },
    });
    manager.registerScreenSlot({
      frameKey: "frame-right",
      iframe: rightIframe,
      slotId: "slot-1",
      trackSid: "TR_right",
      rect: { x: 100, y: 100, width: 10, height: 10 },
    });

    const slots = manager.screenShareSlots$();
    const left = slots.find((s) => s.frameKey === "frame-left");
    const right = slots.find((s) => s.frameKey === "frame-right");
    expect(left?.trackSid).toBe("TR_left");
    expect(left?.iframe).toBe(leftIframe);
    expect(right?.trackSid).toBe("TR_right");
    expect(right?.iframe).toBe(rightIframe);

    manager.unregisterScreenSlot({ frameKey: "frame-left", slotId: "slot-1" });
    manager.unregisterScreenSlot({ frameKey: "frame-right", slotId: "slot-1" });
  });
});

describe("subscribe() initial-snapshot regression (5c-prep fix)", () => {
  test("registering a subscriber does NOT push, even when state.serverId matches", async () => {
    // The pre-fix bug: subscribe() fired an initial snapshot synchronously,
    // but a fresh PluginFrame's iframe was still about:blank, so the pushes
    // were lost. The fix moves snapshot emission to snapshotFor() called
    // from uncorded.ready handler.
    //
    // Stage state.serverId === "srv-Y" via the cap-gate failure path BEFORE
    // subscribing — the old buggy code's initial-snapshot block also gated
    // on `s.serverId === serverId`, so a subscribe-with-mismatch assertion
    // would pass against both the buggy and fixed code. Forcing a serverId
    // match here means a revert of the subscribe-snapshot removal would
    // push three envelopes and fail this test.
    runtimeCapsBySlug = { "voice-channels": [] };
    await manager.connect({
      serverId: "srv-Y",
      slug: "voice-channels",
      channelId: "ch-regression",
    });
    expect(manager.state().serverId).toBe("srv-Y");

    const received: unknown[] = [];
    const unsubscribe = manager.subscribe("srv-Y", "voice-channels", (env) => {
      received.push(env);
    });
    expect(received).toEqual([]);

    // Positive control — snapshotFor() with the same serverId match DOES
    // push the three envelopes. Pins the assertion above as "subscribe is
    // silent" rather than "the fan-out path is no-op everywhere".
    const snapshotted: import("@uncorded/plugin-sdk-frontend").VoiceEnvelope[] = [];
    manager.snapshotFor("srv-Y", (env) => snapshotted.push(env));
    expect(snapshotted).toHaveLength(3);
    expect(snapshotted[0]?.type).toBe("platform.voice.state");
    expect(snapshotted[1]?.type).toBe("platform.voice.participants");
    expect(snapshotted[2]?.type).toBe("platform.voice.active-speakers");

    unsubscribe();
    await manager.disconnect();
  });
});
