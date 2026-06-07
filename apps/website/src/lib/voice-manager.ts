// Shell voice manager — singleton owner of the LiveKit Room, mic capture, and
// `platform.voice.*` push fan-out. See `.claude/docs/Overview/pr-5-voice-client-contract.md`
// (especially §15 "Manager pins") for the design rationale; this file is the
// implementation of those pins.
//
// Lifecycle
// ─────────
//   - Module-level state. Importing this file IS the init — mounting inside a
//     reactive scope that can re-instantiate (route component, workspace
//     component) defeats the entire point of shell ownership (pin #7).
//   - `index.tsx` does `import "@/lib/voice-manager";` for the side-effect.
//   - Cleanup hooks (`pagehide`, `beforeunload`) attach at module load and
//     survive for the page lifetime.
//
// Integration
// ───────────
//   - Iframes in `channel-view.tsx` `createPluginHandle` extend their per-iframe
//     `onMessage` to forward `platform.voice.*` envelopes to `dispatch(...)` here
//     with `{ serverId, slug, ... }` resolved from closure (pin #1).
//   - The same handler calls `subscribe(serverId, slug, fn)` so shell→iframe
//     pushes flow back through the iframe's own `contentWindow.postMessage`.
//   - State pushes are filtered by `serverId` (pin #3) and broadcast to every
//     matching subscriber, so multiple panels of the same plugin all stay in
//     sync (pin #4).

import { createRoot, createSignal, type Accessor, type Setter } from "solid-js";
import type {
  Room,
  RoomEvent as RoomEventType,
  Participant,
  RemoteParticipant,
  TrackPublication,
  RemoteTrackPublication,
  RemoteTrack,
  RemoteAudioTrack,
  LocalTrackPublication,
  DisconnectReason as DisconnectReasonType,
  VideoCodec,
  ScreenShareCaptureOptions,
  TrackPublishOptions,
} from "livekit-client";
import type {
  VoiceState,
  VoiceErrorCode,
  VoiceEnvelope,
  VoiceReason,
  VoiceRequest,
  ParticipantSnapshot,
  ScreenSharePublication,
  VoiceScreenShareSubscription,
  VoiceScreenSharePopoutEntry,
} from "@uncorded/plugin-sdk-frontend";
import { request } from "./ws";
import { getPluginRuntimeCapabilities } from "@/stores/sidebar";
import { account } from "@/stores/auth";

type ScreenShareQualityPreset = "balanced" | "smooth" | "sharp" | "source";

// Re-export the postMessage envelope contract for shell-side consumers. The
// canonical home is `@uncorded/plugin-sdk-frontend` (mirrors §3 / §4 of the
// contract); this re-export keeps `import * as voiceManager` callsites — like
// `channel-view.tsx` accessing `voiceManager.VoiceRequest` — working without
// changes.
export type {
  VoiceStatus,
  VoiceReason,
  VoiceErrorCode,
  ParticipantSnapshot,
  VoiceState,
  VoiceEnvelope,
  VoiceRequest,
} from "@uncorded/plugin-sdk-frontend";

// `voice.join` plugin handler return shape — see plugins/voice-channels/backend/index.ts.
type VoiceJoinResult = {
  token: string;
  livekitUrl: string;
  expiresAt: number;
};

// ---------------------------------------------------------------------------
// Reactive store — single createRoot, never disposed.
// ---------------------------------------------------------------------------

// PR-6 — channel-scoped publisher cap default. Mirrors the default in
// plugins/voice-channels/migrations/003_max_publishers.sql; the runtime is
// the source of truth at runtime, but until the manager learns the real
// value (post-connect, when the SFU reports room metadata or a config push
// arrives), this default keeps the UI from reading 0 / undefined.
const SCREEN_SHARE_DEFAULT_MAX_PUBLISHERS = 10;

// LRU cap — hard limit on simultaneous screen-share subscriptions per
// viewing client. Decision row 2 in the PR-6 plan: 4 streams, click-to-swap.
const SCREEN_SHARE_SUBSCRIPTION_CAP = 4;

const INITIAL_STATE: VoiceState = {
  status: "idle",
  serverId: null,
  channelId: null,
  mic: { available: false, muted: false, serverMuted: false },
  screenShare: {
    publishStatus: "idle",
    quality: "balanced",
    audioShared: false,
    channelMaxPublishers: SCREEN_SHARE_DEFAULT_MAX_PUBLISHERS,
    channelPublisherCount: 0,
    e2eeBlocked: false,
  },
};

const stores = createRoot(() => ({
  state: createSignal<VoiceState>(INITIAL_STATE),
  participants: createSignal<ParticipantSnapshot[]>([]),
  activeSpeakerIds: createSignal<string[]>([]),
  // ms epoch the current session reached `connected` for the first time, or
  // null while idle/connecting/disconnected. The sidebar voice indicator
  // renders elapsed time off this — kept out of VoiceState so the
  // postMessage envelope wire (and the SDK contract) stays unchanged.
  connectedAt: createSignal<number | null>(null),
}));

const [stateAccessor, setStateRaw]: [Accessor<VoiceState>, Setter<VoiceState>] = stores.state;
const [participantsAccessor, setParticipants]: [
  Accessor<ParticipantSnapshot[]>,
  Setter<ParticipantSnapshot[]>,
] = stores.participants;
const [activeSpeakerIdsAccessor, setActiveSpeakerIds]: [
  Accessor<string[]>,
  Setter<string[]>,
] = stores.activeSpeakerIds;
const [connectedAtAccessor, setConnectedAt]: [Accessor<number | null>, Setter<number | null>] =
  stores.connectedAt;

export const state: Accessor<VoiceState> = stateAccessor;
export const participants: Accessor<ParticipantSnapshot[]> = participantsAccessor;
export const activeSpeakerIds: Accessor<string[]> = activeSpeakerIdsAccessor;
export const connectedAt: Accessor<number | null> = connectedAtAccessor;

// ---------------------------------------------------------------------------
// Per-server provisioning — driven by /health/voice on the server's tunnel.
// `setProvisioned(serverId, bool)` is called by the website's startup code
// when the active server changes; we re-broadcast a state envelope tagged
// with `provisioned` so every voice plugin frontend on that server picks up
// the change without a reconnect.
// ---------------------------------------------------------------------------

const provisionedByServer = new Map<string, boolean>();
// Reactive signal mirror so SolidJS components (sidebar dim, channel-view)
// can `createMemo`/`createEffect` on provisioning state without subscribing
// to the iframe envelope path. Updated in lockstep with the Map below.
const [provisionedSignal, setProvisionedSignal] = createSignal<ReadonlyMap<string, boolean>>(
  new Map(),
);

export function isVoiceProvisioned(serverId: string | null): boolean {
  if (serverId === null) return true;
  return provisionedSignal().get(serverId) ?? true;
}

function getProvisioned(serverId: string | null): boolean {
  if (serverId === null) return true;
  // Default to true: a freshly-mounted iframe shouldn't render dimmed before
  // the /health/voice probe completes. The desktop-side gate (no
  // LIVEKIT_PUBLIC_URL → connect attempt fails) keeps the wrong-default safe.
  return provisionedByServer.get(serverId) ?? true;
}

export function setProvisioned(serverId: string, provisioned: boolean): void {
  const prev = provisionedByServer.get(serverId);
  if (prev === provisioned) return;
  provisionedByServer.set(serverId, provisioned);
  setProvisionedSignal(new Map(provisionedByServer));
  // Push a state envelope to every subscriber on this server so dimmed/lit
  // states flip immediately. We don't mutate stateAccessor — provisioning is
  // server-scoped, not session-scoped — so we synthesize the envelope here.
  const s = stateAccessor();
  for (const sub of subscribers) {
    if (sub.serverId !== serverId) continue;
    sub.fn({ type: "platform.voice.state", ...s, provisioned });
  }
}

// ---------------------------------------------------------------------------
// Setup-request listeners — the shell modal subscribes here. Voice plugins
// emit `platform.voice.request-setup` when a user clicks a dimmed channel;
// the shell listens, owner-gates, and renders the setup modal.
// ---------------------------------------------------------------------------

type SetupRequestListener = (serverId: string) => void;
const setupRequestListeners = new Set<SetupRequestListener>();

export function onRequestSetup(fn: SetupRequestListener): () => void {
  setupRequestListeners.add(fn);
  return () => setupRequestListeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Subscriber registry — iframes register here from `createPluginHandle`.
// ---------------------------------------------------------------------------

type Subscriber = {
  serverId: string;
  slug: string;
  fn: (env: VoiceEnvelope) => void;
};

const subscribers = new Set<Subscriber>();

export function subscribe(
  serverId: string,
  slug: string,
  fn: (env: VoiceEnvelope) => void,
): () => void {
  const sub: Subscriber = { serverId, slug, fn };
  subscribers.add(sub);
  // No initial snapshot here. Posting at subscribe-time is unsafe: a fresh
  // PluginFrame mount creates the iframe element first, registers this
  // subscriber, and only then sets `iframe.src` — so initial-snapshot pushes
  // would land in `about:blank` (no dispatch listener) and be lost. Callers
  // that need a snapshot trigger one explicitly via `snapshotFor()` once the
  // iframe handshake has completed (see channel-view.tsx onMessage's
  // `uncorded.ready` branch).
  return () => {
    subscribers.delete(sub);
  };
}

// Push the current voice snapshot (state + participants + active-speakers) to
// `fn`, but only if this iframe's serverId matches the active connection so we
// don't leak state across servers (pin #3). Used by channel-view.tsx after the
// iframe handshake completes — at that point the iframe's dispatch listener
// is attached, so the snapshot lands instead of being dropped at about:blank.
export function snapshotFor(
  serverId: string,
  fn: (env: VoiceEnvelope) => void,
): void {
  const s = stateAccessor();
  // Always push a state envelope tagged with this server's provisioned flag,
  // even when there's no active session — dimmed-sidebar rendering depends
  // on it. The serverId-match guard for participants/speakers below preserves
  // pin #3 (no cross-server leak) since those are session-scoped.
  fn({ type: "platform.voice.state", ...s, provisioned: getProvisioned(serverId) });
  if (s.serverId !== serverId) return;
  fn({ type: "platform.voice.participants", participants: participantsAccessor() });
  fn({ type: "platform.voice.active-speakers", speakingUserIds: activeSpeakerIdsAccessor() });
}

function broadcast(env: VoiceEnvelope, scope: { serverId: string | null }): void {
  if (scope.serverId === null) return;
  for (const sub of subscribers) {
    if (sub.serverId === scope.serverId) sub.fn(env);
  }
}

function pushState(): void {
  const s = stateAccessor();
  // Per-subscriber provisioned tag — every voice plugin on a given server
  // sees that server's flag, not a global one. Two open servers with mixed
  // provisioning state stay correctly differentiated.
  for (const sub of subscribers) {
    if (s.serverId !== null && sub.serverId !== s.serverId) continue;
    sub.fn({
      type: "platform.voice.state",
      ...s,
      provisioned: getProvisioned(sub.serverId),
    });
  }
}

function pushParticipants(): void {
  const s = stateAccessor();
  broadcast(
    { type: "platform.voice.participants", participants: participantsAccessor() },
    { serverId: s.serverId },
  );
}

function pushActiveSpeakers(): void {
  const s = stateAccessor();
  broadcast(
    { type: "platform.voice.active-speakers", speakingUserIds: activeSpeakerIdsAccessor() },
    { serverId: s.serverId },
  );
}

function pushError(code: VoiceErrorCode, message: string): void {
  const s = stateAccessor();
  broadcast({ type: "platform.voice.error", code, message }, { serverId: s.serverId });
}

function setState(patch: Partial<VoiceState>): void {
  setStateRaw((prev) => ({ ...prev, ...patch }));
  pushState();
}

// ---------------------------------------------------------------------------
// Lazy-loaded livekit-client chunk (pin #6, contract §12).
// ---------------------------------------------------------------------------

type LivekitModule = typeof import("livekit-client");

let livekitModule: LivekitModule | null = null;
let livekitImportPromise: Promise<LivekitModule> | null = null;

function loadLivekit(): Promise<LivekitModule> {
  if (livekitModule) return Promise.resolve(livekitModule);
  if (!livekitImportPromise) {
    livekitImportPromise = import("livekit-client")
      .then((m) => {
        livekitModule = m;
        return m;
      })
      .catch((err) => {
        // Drop the cached promise so a Retry click triggers a fresh import —
        // common case is a chunk-hash mismatch right after a deploy, where the
        // next attempt fetches the new hash.
        livekitImportPromise = null;
        throw err;
      });
  }
  return livekitImportPromise;
}

// ---------------------------------------------------------------------------
// Connection lifecycle — cancel-and-replace via attemptId (pin #5).
// ---------------------------------------------------------------------------

let room: Room | null = null;
let attemptId = 0;
// Per-attempt AbortController — wired into the WS request() for the token
// mint so a cancel-and-replace doesn't leave an orphan token-mint round-trip
// running server-side (audit row, runtime log line) just to discard the result.
let attemptAbort: AbortController | null = null;
// Last connect arguments — kept so `retry()` from the indicator can re-run the
// same flow without the indicator owning the channel/server identity.
let lastConnect: ConnectArgs | null = null;

export type ConnectArgs = {
  serverId: string;
  slug: string;
  channelId: string;
  channelName?: string;
};

// ---------------------------------------------------------------------------
// PR-6 — screen-share state (publish-side + subscription-side).
// ---------------------------------------------------------------------------

// In-flight `getDisplayMedia` / `setScreenShareEnabled(true)` Promise. Concurrent
// `start-screen-share` dispatches return this rather than opening a second
// picker (mirrors the openConnection() dedup pattern from PR-5; see
// memory feedback_ws_connect_race.md).
let inFlightStartShare: Promise<void> | null = null;

// LRU subscription queue — most-recently subscribed at the end. Capped at
// SCREEN_SHARE_SUBSCRIPTION_CAP. Audio peer subscription always tracks the
// same trackSid as its paired video (atomic coupling, plan §5).
const screenShareSubscriptionQueue: string[] = [];

// Manual unsubscribes — when the user taps "remove from grid" we want to
// keep the publication out of the LRU even when its publisher republishes.
// Cleared on the publisher's next manual republish or on disconnect.
const explicitlyUnsubscribed = new Set<string>();

// Per-listener volume scaling for screen-share-audio peer tracks. 0–1, 1 = unity.
const screenShareAudioVolumes = new Map<string, number>();
// User-side per-track audio mute (independent of publisher mute, similar to
// the mic peer-side mute pattern).
const screenShareAudioLocalMuted = new Set<string>();
// Tracks that were popped out into a borderless window. Shell paints a
// "Watching in popout" placeholder in the in-frame slot while popped.
const screenSharePoppedOut = new Set<string>();

// Slot reservations from plugin iframes. Keyed by frameKey so two panels of
// the same plugin (split view) keep their slots distinct. The overlay reads
// this to paint <video> elements over each rect (6e).
//
// `iframe` is the load-bearing reference for positioning: the overlay reads
// `iframe.getBoundingClientRect()` directly each rAF tick. Using the element
// (not the frameKey string) means cross-workspace drag's `portalHost.rekey`
// can't desync the overlay — the iframe object is stable across rekeys, hides,
// and adoptions for the lifetime of the plugin handle. `frameKey` is retained
// only for the by-frame unregister sweep at iframe teardown.
export interface ScreenShareSlotEntry {
  frameKey: string;
  iframe: HTMLIFrameElement;
  slotId: string;
  trackSid: string;
  rect: { x: number; y: number; width: number; height: number };
}
const screenShareSlots = new Map<string, ScreenShareSlotEntry>();
function slotKey(frameKey: string, slotId: string): string {
  return `${frameKey}::${slotId}`;
}

// Reactive accessor for slot map — used by the overlay component (6e).
const [screenShareSlotsSignal, setScreenShareSlotsSignal] = createSignal<
  ReadonlyArray<ScreenShareSlotEntry>
>([]);
export const screenShareSlots$: Accessor<ReadonlyArray<ScreenShareSlotEntry>> =
  screenShareSlotsSignal;
function publishSlotsSignal(): void {
  setScreenShareSlotsSignal(Array.from(screenShareSlots.values()));
}

// Reactive accessor for the active room (used by the overlay to attach
// <video> elements to RemoteVideoTrack via track.attach()).
const [activeRoomSignal, setActiveRoomSignal] = createSignal<Room | null>(null);
export const activeRoom$: Accessor<Room | null> = activeRoomSignal;

// Bumps every time a screen-share video track subscribes or unsubscribes.
// The overlay's shapes memo reads this so `findScreenShareVideoTrack` re-runs
// when the SFU finally delivers a track (slot registration races ahead of the
// TrackSubscribed event — without this bump, shapes() resolves track=null on
// first run and never re-runs, leaving the <video> element with no srcObject).
const [screenShareTrackVersion, setScreenShareTrackVersion] = createSignal(0);
export const screenShareTrackVersion$: Accessor<number> = screenShareTrackVersion;
function bumpScreenShareTrackVersion(): void {
  setScreenShareTrackVersion((n) => n + 1);
}

// Reactive mirror of the popped-out track sid set. The overlay reads this to
// decide whether to render the in-frame <video> or the "Watching in popout"
// placeholder, and to spawn the fullscreen popout layer.
const [screenSharePoppedOutSignal, setScreenSharePoppedOutSignal] = createSignal<
  ReadonlySet<string>
>(new Set());
export const screenSharePoppedOut$: Accessor<ReadonlySet<string>> = screenSharePoppedOutSignal;
function publishPoppedOutSignal(): void {
  setScreenSharePoppedOutSignal(new Set(screenSharePoppedOut));
}

export async function connect(args: ConnectArgs): Promise<void> {
  const { serverId, slug, channelId, channelName } = args;
  lastConnect = args;

  if (!getPluginRuntimeCapabilities(slug).includes("voice.media")) {
    const message = `Plugin "${slug}" does not have voice.media capability.`;
    // Inline rather than the spread-merge `setState` helper because we need
    // to OVERWRITE channelName on the failed state. A conditional spread
    // injects nothing when the caller didn't pass one, leaving prev's stale
    // channelName intact. (Same hazard the connecting path inlines around.)
    setStateRaw((prev) => {
      const next: VoiceState = {
        ...prev,
        status: "failed",
        serverId,
        channelId,
        mic: { available: false, muted: false, serverMuted: false },
        reason: "voice_media_not_granted",
        error: { code: "voice_media_not_granted", message },
      };
      if (channelName !== undefined) {
        next.channelName = channelName;
      } else {
        delete next.channelName;
      }
      return next;
    });
    pushState();
    pushError("voice_media_not_granted", message);
    return;
  }

  const myAttempt = ++attemptId;
  // Cancel any in-flight token-mint from a prior attempt before bumping the
  // controller. The previous attempt's request() resolves with AbortError on
  // its handler, runtime never sees the response routed back to a live caller.
  if (attemptAbort) attemptAbort.abort();
  const myAbort = new AbortController();
  attemptAbort = myAbort;

  // Tear down any existing room before starting the new attempt. `disconnect`
  // is idempotent and synchronous (it schedules the WS Leave but doesn't await).
  if (room) {
    try {
      await room.disconnect();
    } catch {
      // ignore — we're replacing it anyway
    }
    room = null;
  }
  setParticipants([]);
  setActiveSpeakerIds([]);

  // Inline rather than the helper because we need to overwrite channelName
  // (set from args, or absent if the caller didn't pass one) — the helper's
  // spread-merge keeps prev.channelName otherwise, leaking the previous
  // channel's name into the new connect.
  setStateRaw((prev) => {
    const next: VoiceState = {
      ...prev,
      status: "connecting",
      serverId,
      channelId,
      mic: { available: false, muted: false, serverMuted: false },
    };
    delete next.reason;
    delete next.error;
    if (channelName !== undefined) {
      next.channelName = channelName;
    } else {
      delete next.channelName;
    }
    return next;
  });
  pushState();

  let lk: LivekitModule;
  try {
    lk = await loadLivekit();
  } catch (err) {
    if (myAttempt !== attemptId) return;
    const message = err instanceof Error ? err.message : "Failed to load voice client.";
    setState({
      status: "failed",
      reason: "client_load_failed",
      error: { code: "client_load_failed", message },
    });
    pushError("client_load_failed", message);
    return;
  }
  if (myAttempt !== attemptId) return;

  let mintResult: VoiceJoinResult;
  try {
    mintResult = await request<VoiceJoinResult>(
      serverId,
      "voice-channels",
      "voice.join",
      { channelId },
      { signal: myAbort.signal },
    );
  } catch (err) {
    if (myAttempt !== attemptId) return;
    const message = err instanceof Error ? err.message : "Token mint failed.";
    setState({
      status: "failed",
      reason: "auth_denied",
      error: { code: "token_mint_failed", message },
    });
    pushError("token_mint_failed", message);
    return;
  }
  if (myAttempt !== attemptId) return;

  const newRoom = new lk.Room({
    adaptiveStream: true,
    dynacast: true,
    // Route all remote audio through a Web Audio graph (LiveKit creates a
    // shared AudioContext + per-track GainNodes). Required so per-user
    // volume control works on iOS Safari, where HTMLMediaElement.volume is
    // read-only and `el.volume = x` is silently ignored. With this on,
    // RemoteAudioTrack.setVolume() routes to gain.setTargetAtTime() — which
    // IS writable on iOS — and the slider takes effect on every platform,
    // not just Electron/Chromium where el.volume happens to be honoured.
    // LiveKit also notes this "helps to tackle some audio auto playback
    // issues", which dovetails with our existing audioPlaybackBlocked flow.
    webAudioMix: true,
  });
  wireRoomEvents(newRoom, lk);

  try {
    await newRoom.connect(mintResult.livekitUrl, mintResult.token);
  } catch (err) {
    if (myAttempt !== attemptId) {
      try {
        await newRoom.disconnect();
      } catch {
        // ignore
      }
      return;
    }
    const message = err instanceof Error ? err.message : "Voice service unreachable.";
    // Identity collision sometimes surfaces here (LiveKit Leave during signaling
    // before connect() resolves) rather than on the Disconnected event. Map it
    // to identity_collision so §13's two-tab smoke test matches the same UI
    // path as the post-connect collision case at the Disconnected handler below.
    if (isDuplicateIdentityError(err, lk)) {
      setState({
        status: "failed",
        reason: "identity_collision",
        error: { code: "identity_collision", message: "Already connected from another tab." },
      });
      pushError("identity_collision", "Already connected from another tab.");
      return;
    }
    setState({
      status: "failed",
      error: { code: "livekit_unreachable", message },
    });
    pushError("livekit_unreachable", message);
    return;
  }
  if (myAttempt !== attemptId) {
    try {
      await newRoom.disconnect();
    } catch {
      // ignore
    }
    return;
  }

  room = newRoom;
  // PR-6 — publish the active room so the overlay component (6e) can
  // attach <video> elements to RemoteVideoTracks via track.attach(). The
  // signal is a fine-grained accessor (no deep equality), so the overlay
  // re-runs only on identity change.
  setActiveRoomSignal(newRoom);

  // Mic capture — pinned constraints from §10. A rejection here means the user
  // denied permission; we proceed connected with mic.available=false rather
  // than failing the whole connect, matching §13's "Mic permission denied"
  // smoke-test row.
  let micAvailable = false;
  try {
    await newRoom.localParticipant.setMicrophoneEnabled(true, {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    micAvailable = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Microphone unavailable.";
    pushError("mic_permission_denied", message);
  }
  if (myAttempt !== attemptId) {
    try {
      await newRoom.disconnect();
    } catch {
      // ignore
    }
    return;
  }

  // Seed audioPlaybackBlocked from the live Room. AudioPlaybackStatusChanged
  // fires on transitions, so without this seed a session that joins already
  // blocked (returning visitor, no shell-side gesture in this tab) would
  // never tell the iframe to render an Enable-audio affordance.
  setState({
    status: "connected",
    mic: { available: micAvailable, muted: !micAvailable, serverMuted: false },
    audioPlaybackBlocked: !newRoom.canPlaybackAudio,
  });
  // Stamp the session start. Only set if not already set so a reconnect
  // (status: reconnecting → connected) doesn't reset the elapsed counter —
  // the user perceives a brief network hiccup as the same session, not a
  // new one.
  if (connectedAtAccessor() === null) setConnectedAt(Date.now());
  refreshParticipants();
  // Catch up on screen-share publications that arrived during connect(). The
  // TrackPublished / TrackSubscribed handlers fire synchronously inside
  // `await newRoom.connect()` for participants already in the room, BEFORE
  // `room = newRoom` was assigned above — so the early `!room` guards in
  // refreshScreenShareSubscriptionsAfterMembershipChange and
  // pushScreenShareSubscriptions returned without populating the LRU queue
  // or notifying the iframe. Re-run now that `room` is live so the iframe
  // sees the subscriptions and registers slot rectangles.
  refreshScreenShareSubscriptionsAfterMembershipChange();
  bumpScreenShareTrackVersion();
}

export async function disconnect(): Promise<void> {
  attemptId++;
  if (attemptAbort) {
    attemptAbort.abort();
    attemptAbort = null;
  }
  // Clear lastConnect so retry() from any future surface doesn't reconnect to
  // a stale channel after an explicit leave. Today retry() only renders inside
  // the failed-state row, but defending against future debug-/hotkey-paths is
  // cheap; if you don't intend ever to call retry from outside failed, this
  // is just dead code that doesn't hurt.
  lastConnect = null;
  const r = room;
  room = null;
  setActiveRoomSignal(null);
  if (r) {
    try {
      await r.disconnect();
    } catch {
      // ignore
    }
  }
  setParticipants([]);
  setActiveSpeakerIds([]);
  setConnectedAt(null);
  // Session-scoped state — clear so the next join starts clean. Otherwise a
  // user who deafened in room A and rejoins room B walks in deafened.
  localVolumes.clear();
  preDeafenMicMuted = null;
  // PR-6 — wipe screen-share session state. LRU queue, explicit-unsub set,
  // popouts, audio volumes/mutes, and slot reservations are all
  // session-scoped (a user who removed a tile in room A shouldn't have
  // that hidden in room B). Slots get explicit-unregister at iframe
  // unmount, but a clean disconnect should also flush them so a stale
  // overlay paints nothing during the brief idle window.
  screenShareSubscriptionQueue.length = 0;
  explicitlyUnsubscribed.clear();
  screenShareAudioVolumes.clear();
  screenShareAudioLocalMuted.clear();
  screenSharePoppedOut.clear();
  publishPoppedOutSignal();
  screenShareSlots.clear();
  publishSlotsSignal();
  inFlightStartShare = null;
  // Single state push: clear any prior reason/error and set the new explicit
  // reason in one updater so subscribers see one envelope, not two.
  setStateRaw((prev) => {
    const next: VoiceState = {
      ...prev,
      status: "disconnected",
      serverId: null,
      channelId: null,
      mic: { available: false, muted: false, serverMuted: false },
    };
    delete next.channelName;
    delete next.error;
    delete next.deafened;
    next.reason = "explicit";
    return next;
  });
  pushState();
}

export function setMicMuted(muted: boolean): void {
  const s = stateAccessor();
  if (s.mic.serverMuted && !muted) {
    // Server-mute pre-empts a user unmute. Re-push current state so the UI
    // resyncs the toggle if it tried to be optimistic.
    pushState();
    return;
  }
  if (!room) return;
  void room.localParticipant
    .setMicrophoneEnabled(!muted)
    .then(() => {
      setState({ mic: { ...stateAccessor().mic, muted } });
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Failed to toggle microphone.";
      pushError("mic_permission_denied", message);
      // Re-publish the canonical state so any optimistic UI toggle resyncs to
      // the live mic.muted (which didn't change because the LiveKit call
      // rejected). Without this push the indicator could show "muted" while
      // the track is still publishing audio.
      pushState();
    });
}

export function setLocalParticipantMuted(userId: string, muted: boolean): void {
  if (!room) return;
  for (const p of room.remoteParticipants.values()) {
    if (p.identity !== userId) continue;
    for (const pub of p.audioTrackPublications.values()) {
      pub.setSubscribed(!muted);
    }
  }
  setParticipants((prev) =>
    prev.map((p) => (p.userId === userId ? { ...p, localMuted: muted } : p)),
  );
  pushParticipants();
}

// Per-user listener volume (0–1, 1 = unity). LiveKit's RemoteAudioTrack
// .setVolume() forwards to the underlying HTMLMediaElement.volume, which
// only accepts [0, 1] — values outside that range throw IndexSizeError.
// Gain boost (>1) would require wiring a Web Audio GainNode in front of the
// audio element; deferred for now. Stored so we can re-apply on republish
// and so deafen can restore the user's pre-deafen scale.
const localVolumes = new Map<string, number>();

function applyVolumeForParticipant(userId: string, volume: number): void {
  if (!room) return;
  for (const p of room.remoteParticipants.values()) {
    if (p.identity !== userId) continue;
    for (const pub of p.audioTrackPublications.values()) {
      const track = pub.audioTrack;
      // RemoteAudioTrack exposes setVolume; LocalAudioTrack does not, but
      // remote-only is what we'd ever target — guard anyway in case the SDK
      // changes shape.
      if (track && typeof (track as { setVolume?: (v: number) => void }).setVolume === "function") {
        (track as { setVolume: (v: number) => void }).setVolume(volume);
      }
    }
  }
}

export function setLocalParticipantVolume(userId: string, volume: number): void {
  if (!Number.isFinite(volume) || volume < 0) return;
  // HTMLMediaElement.volume only accepts [0, 1]; values outside throw
  // IndexSizeError synchronously. Cap at 1.0 so a slider request that
  // somehow exceeds the UI bound (out-of-band caller, future regression)
  // can't crash the audio element.
  const clamped = Math.min(volume, 1);
  localVolumes.set(userId, clamped);
  // While deafened we don't actually push the volume to the track — every
  // remote is at 0. The stored value is what we restore when undeafening.
  if (!stateAccessor().deafened) applyVolumeForParticipant(userId, clamped);
  setParticipants((prev) =>
    prev.map((p) => (p.userId === userId ? { ...p, localVolume: clamped } : p)),
  );
  pushParticipants();
}

// Deafen — drop all remote audio + force-mute the local mic. We track the
// pre-deafen mic state so undeafen restores it: a user who was muted before
// deafening stays muted after; a user who wasn't gets their mic back. Same
// idea for per-user volumes — undeafen replays the stored value.
let preDeafenMicMuted: boolean | null = null;

function applyDeafenToAllRemotes(deafened: boolean): void {
  if (!room) return;
  for (const p of room.remoteParticipants.values()) {
    const userVolume = localVolumes.get(p.identity) ?? 1;
    const target = deafened ? 0 : userVolume;
    for (const pub of p.audioTrackPublications.values()) {
      const track = pub.audioTrack;
      if (track && typeof (track as { setVolume?: (v: number) => void }).setVolume === "function") {
        (track as { setVolume: (v: number) => void }).setVolume(target);
      }
    }
  }
}

export function setDeafened(deafened: boolean): void {
  if (!room) return;
  const s = stateAccessor();
  if ((s.deafened ?? false) === deafened) return;
  if (deafened) {
    preDeafenMicMuted = s.mic.muted;
    // Force-mute the mic — but only flip the publisher; preserve the user's
    // original `muted` flag in our tracked state via preDeafenMicMuted.
    if (!s.mic.muted) {
      void room.localParticipant.setMicrophoneEnabled(false).catch(() => {
        // Best-effort; if the mute call rejects we stay deafened on the
        // listener side and the user can manually mute.
      });
    }
    applyDeafenToAllRemotes(true);
    setState({ deafened: true, mic: { ...s.mic, muted: true } });
  } else {
    applyDeafenToAllRemotes(false);
    const restoreMuted = preDeafenMicMuted ?? false;
    preDeafenMicMuted = null;
    if (!restoreMuted) {
      void room.localParticipant.setMicrophoneEnabled(true).catch(() => {});
    }
    setState({ deafened: false, mic: { ...s.mic, muted: restoreMuted } });
  }
  pushState();
}

export function retry(): void {
  if (!lastConnect) return;
  void connect(lastConnect);
}

// ---------------------------------------------------------------------------
// PR-6 — screen share publish path.
// ---------------------------------------------------------------------------

function pushScreenShareSubscriptions(): void {
  const s = stateAccessor();
  if (s.serverId === null || !room) return;
  const subs: VoiceScreenShareSubscription[] = [];
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.videoTrackPublications.values()) {
      if (!isScreenShareVideoPub(pub)) continue;
      const sid = pub.trackSid;
      const subscribed =
        screenShareSubscriptionQueue.includes(sid) && pub.isSubscribed;
      const volume = screenShareAudioVolumes.get(sid) ?? 1;
      const audioMuted = screenShareAudioLocalMuted.has(sid);
      const streamPaused = pub.track?.streamState === "paused";
      subs.push({
        trackSid: sid,
        userId: p.identity,
        subscribed,
        volumePctClient: audioMuted ? 0 : Math.round(volume * 100),
        streamPaused,
      });
    }
  }
  broadcast(
    { type: "platform.voice.screen-share.subscriptions", subscriptions: subs },
    { serverId: s.serverId },
  );
}

function pushScreenSharePopouts(): void {
  const s = stateAccessor();
  if (s.serverId === null) return;
  const popouts: VoiceScreenSharePopoutEntry[] = [];
  for (const trackSid of screenSharePoppedOut) {
    popouts.push({ trackSid, popped: true });
  }
  broadcast(
    { type: "platform.voice.screen-share.popouts", popouts },
    { serverId: s.serverId },
  );
}

function isScreenShareVideoPub(pub: TrackPublication): boolean {
  return pub.source === "screen_share";
}

function isScreenShareAudioPub(pub: TrackPublication): boolean {
  return pub.source === "screen_share_audio";
}

function findScreenShareAudioPubFor(
  videoSid: string,
): RemoteTrackPublication | null {
  if (!room) return null;
  for (const p of room.remoteParticipants.values()) {
    let videoBelongsToThisParticipant = false;
    for (const pub of p.videoTrackPublications.values()) {
      if (pub.trackSid === videoSid && isScreenShareVideoPub(pub)) {
        videoBelongsToThisParticipant = true;
        break;
      }
    }
    if (!videoBelongsToThisParticipant) continue;
    for (const pub of p.audioTrackPublications.values()) {
      if (isScreenShareAudioPub(pub)) return pub;
    }
    return null;
  }
  return null;
}

function presetCaptureOptions(
  audio: boolean,
  quality: ScreenShareQualityPreset,
): ScreenShareCaptureOptions {
  // Balanced/sharp/source use 1080p; smooth trades resolution for 60 fps.
  const fps = quality === "smooth" || quality === "source" ? 60 : 30;
  const height = quality === "smooth" ? 720 : 1080;
  const width = quality === "smooth" ? 1280 : 1920;
  const contentHint: "detail" | "motion" =
    quality === "smooth" || quality === "source" ? "motion" : "detail";
  return {
    audio,
    video: true,
    resolution: { width, height, frameRate: fps },
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    systemAudio: audio ? "include" : "exclude",
    contentHint,
  };
}

function pickScreenShareVideoCodec(): VideoCodec {
  // LiveKit 2.18 overrides VP9 screen share to single-spatial-layer SVC
  // internally because Chrome's screen-share VP9 path is still fragile. VP8
  // keeps regular simulcast available, which gives adaptive subscribers a real
  // half-res layer instead of forcing one full-res stream through every layout.
  return "vp8";
}

function presetEncoding(
  quality: ScreenShareQualityPreset,
): TrackPublishOptions {
  const codec = pickScreenShareVideoCodec();
  const maxBitrate =
    quality === "source"
      ? 10_000_000
      : quality === "sharp"
        ? 7_000_000
        : quality === "smooth"
          ? 4_500_000
          : 5_000_000;
  const opts: TrackPublishOptions = {
    videoCodec: codec,
    simulcast: true,
    degradationPreference:
      quality === "smooth" || quality === "source"
        ? "maintain-framerate"
        : "maintain-resolution",
    screenShareEncoding: {
      maxBitrate,
      maxFramerate: quality === "smooth" || quality === "source" ? 60 : 30,
    },
  };
  return opts;
}

export async function startScreenShare(input: {
  audio: boolean;
  quality: ScreenShareQualityPreset;
  sourceId?: string;
}): Promise<void> {
  // Concurrent dispatch dedup — second click in the same tick shares the
  // first call's outcome rather than opening another picker.
  if (inFlightStartShare) return inFlightStartShare;
  const s = stateAccessor();
  if (!room) {
    pushError(
      "screen_share_permission_denied",
      "Connect to voice before starting a screen share.",
    );
    return;
  }
  if (s.screenShare?.e2eeBlocked) {
    pushError(
      "screen_share_e2ee_unsupported",
      "Screen share is unavailable on encrypted channels.",
    );
    return;
  }
  if (
    s.screenShare !== undefined &&
    s.screenShare.channelPublisherCount >= s.screenShare.channelMaxPublishers &&
    s.screenShare.publishStatus !== "publishing"
  ) {
    pushError(
      "screen_share_room_full",
      "Channel is at the screen-share publisher limit.",
    );
    return;
  }

  const r = room;
  setState({
    screenShare: {
      ...(s.screenShare ?? defaultScreenShareState()),
      publishStatus: "starting",
      quality: input.quality,
      audioShared: input.audio,
    },
  });

  const captureOpts = presetCaptureOptions(input.audio, input.quality);
  const publishOpts = presetEncoding(input.quality);

  inFlightStartShare = (async () => {
    try {
      const pub = await r.localParticipant.setScreenShareEnabled(
        true,
        captureOpts,
        publishOpts,
      );
      const trackSid = pub?.trackSid;
      const cur = stateAccessor().screenShare ?? defaultScreenShareState();
      setState({
        screenShare: {
          ...cur,
          publishStatus: "publishing",
          ...(trackSid !== undefined ? { publishTrackSid: trackSid } : {}),
        },
      });

      // Auto-stop on user-closed source (`MediaStreamTrack.ended`). LiveKit
      // surfaces this via the LocalTrackPublication's track.on("ended"). The
      // simplest cross-version-safe path is to listen on the underlying
      // mediaStreamTrack directly.
      const track = pub?.track;
      const mst = track?.mediaStreamTrack;
      if (mst) {
        mst.addEventListener(
          "ended",
          () => {
            void stopScreenShare();
          },
          { once: true },
        );
      }
    } catch (err) {
      const cur = stateAccessor().screenShare ?? defaultScreenShareState();
      setState({
        screenShare: { ...cur, publishStatus: "idle" },
      });
      const message = err instanceof Error ? err.message : String(err);
      // LiveKit's permissions failure surfaces as a connection-error name
      // "PublishError" / "NegotiationError" with a permissions message. We
      // map by string sniff because the JS SDK doesn't expose a typed code.
      if (
        /not allowed|permission/i.test(message) &&
        !/user denied|cancel/i.test(message)
      ) {
        pushError("screen_share_permission_denied", message);
      } else if (/cancel|abort|denied/i.test(message)) {
        // User dismissed the picker — soft signal, no state change beyond
        // returning to idle (already done above).
        pushError("screen_share_cancelled", message);
      } else if (/codec|negotiation/i.test(message)) {
        pushError("screen_share_codec_unsupported", message);
      } else {
        pushError("screen_share_permission_denied", message);
      }
    } finally {
      inFlightStartShare = null;
    }
  })();
  return inFlightStartShare;
}

export async function stopScreenShare(): Promise<void> {
  const r = room;
  if (!r) return;
  const cur = stateAccessor().screenShare ?? defaultScreenShareState();
  if (cur.publishStatus === "idle" || cur.publishStatus === "stopping") return;
  setState({ screenShare: { ...cur, publishStatus: "stopping" } });
  try {
    await r.localParticipant.setScreenShareEnabled(false);
  } catch {
    // best-effort; if the SFU rejects we still want to clear local state.
  }
  // Close popouts owned by the local publisher.
  if (cur.publishTrackSid !== undefined) {
    screenSharePoppedOut.delete(cur.publishTrackSid);
    pushScreenSharePopouts();
  }
  const next = stateAccessor().screenShare ?? defaultScreenShareState();
  const cleared: VoiceState["screenShare"] = {
    publishStatus: "idle",
    quality: next.quality,
    audioShared: false,
    channelMaxPublishers: next.channelMaxPublishers,
    channelPublisherCount: next.channelPublisherCount,
    e2eeBlocked: next.e2eeBlocked,
  };
  setState({ screenShare: cleared });
}

export async function setScreenShareQuality(
  quality: ScreenShareQualityPreset,
): Promise<void> {
  const cur = stateAccessor().screenShare ?? defaultScreenShareState();
  if (cur.quality === quality) return;
  // First attempt: hot-swap with `replaceTrack` on the local video pub. If
  // unavailable on this livekit-client version, fall back to stop + restart
  // (acceptable brief gap, plan decision row 8).
  const r = room;
  if (!r || cur.publishStatus !== "publishing") {
    setState({ screenShare: { ...cur, quality } });
    return;
  }
  // Stop+restart fallback. livekit-client 2.x does expose
  // LocalVideoTrack.replaceTrack, but its semantics for swapping encoding
  // are not stable across patch versions; the safe, contract-explicit path
  // is unpublish+republish. UI shows the publishStatus transition.
  setState({ screenShare: { ...cur, quality, publishStatus: "stopping" } });
  try {
    await r.localParticipant.setScreenShareEnabled(false);
  } catch {
    // ignore
  }
  await startScreenShare({ audio: cur.audioShared, quality });
}

export function popoutScreenShare(trackSid: string): void {
  if (screenSharePoppedOut.has(trackSid)) return;
  screenSharePoppedOut.add(trackSid);
  publishPoppedOutSignal();
  pushScreenSharePopouts();
}

export function dockScreenShare(trackSid: string): void {
  if (!screenSharePoppedOut.has(trackSid)) return;
  screenSharePoppedOut.delete(trackSid);
  publishPoppedOutSignal();
  pushScreenSharePopouts();
}

export function setScreenShareVolume(trackSid: string, volumePct: number): void {
  if (!Number.isFinite(volumePct)) return;
  const clamped = Math.max(0, Math.min(100, volumePct)) / 100;
  screenShareAudioVolumes.set(trackSid, clamped);
  applyScreenShareAudioVolume(trackSid);
  pushScreenShareSubscriptions();
}

export function muteScreenShareAudio(trackSid: string, muted: boolean): void {
  if (muted) screenShareAudioLocalMuted.add(trackSid);
  else screenShareAudioLocalMuted.delete(trackSid);
  applyScreenShareAudioVolume(trackSid);
  pushScreenShareSubscriptions();
}

function applyScreenShareAudioVolume(videoTrackSid: string): void {
  const audioPub = findScreenShareAudioPubFor(videoTrackSid);
  if (!audioPub) return;
  const track = audioPub.audioTrack as RemoteAudioTrack | undefined;
  if (!track || typeof track.setVolume !== "function") return;
  const muted = screenShareAudioLocalMuted.has(videoTrackSid);
  const stored = screenShareAudioVolumes.get(videoTrackSid) ?? 1;
  track.setVolume(muted ? 0 : stored);
}

// LRU subscribe: the manager guarantees ≤ SCREEN_SHARE_SUBSCRIPTION_CAP active
// video subscriptions per client; the audio peer is atomically coupled.
export async function subscribeScreenShare(trackSid: string): Promise<void> {
  if (!room) return;
  const pubInfo = findScreenSharePubsByVideoSid(trackSid);
  if (!pubInfo) return;
  explicitlyUnsubscribed.delete(trackSid);

  // Move to MRU position.
  const idx = screenShareSubscriptionQueue.indexOf(trackSid);
  if (idx !== -1) screenShareSubscriptionQueue.splice(idx, 1);
  screenShareSubscriptionQueue.push(trackSid);

  // Evict LRU when over cap.
  while (screenShareSubscriptionQueue.length > SCREEN_SHARE_SUBSCRIPTION_CAP) {
    const evictedSid = screenShareSubscriptionQueue.shift()!;
    const evictedInfo = findScreenSharePubsByVideoSid(evictedSid);
    if (evictedInfo) {
      // Audio first (so the in-frame video doesn't keep playing audio of an
      // evicted publisher for one frame). LiveKit setSubscribed is idempotent.
      evictedInfo.audio?.setSubscribed(false);
      evictedInfo.video.setSubscribed(false);
    }
  }

  // Atomic coupling: subscribe audio first if present, then video. Doing
  // audio first avoids a one-frame "video without audio" flicker on swap.
  pubInfo.audio?.setSubscribed(true);
  pubInfo.video.setSubscribed(true);
  applyScreenShareAudioVolume(trackSid);
  pushScreenShareSubscriptions();
}

export function unsubscribeScreenShare(trackSid: string): void {
  if (!room) return;
  explicitlyUnsubscribed.add(trackSid);
  const idx = screenShareSubscriptionQueue.indexOf(trackSid);
  if (idx !== -1) screenShareSubscriptionQueue.splice(idx, 1);
  const pubInfo = findScreenSharePubsByVideoSid(trackSid);
  if (pubInfo) {
    pubInfo.video.setSubscribed(false);
    pubInfo.audio?.setSubscribed(false);
  }
  pushScreenShareSubscriptions();
}

interface ScreenSharePubPair {
  participant: RemoteParticipant;
  video: RemoteTrackPublication;
  audio: RemoteTrackPublication | null;
}

function findScreenSharePubsByVideoSid(
  videoSid: string,
): ScreenSharePubPair | null {
  if (!room) return null;
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.videoTrackPublications.values()) {
      if (pub.trackSid !== videoSid || !isScreenShareVideoPub(pub)) continue;
      let audioPub: RemoteTrackPublication | null = null;
      for (const apub of p.audioTrackPublications.values()) {
        if (isScreenShareAudioPub(apub)) {
          audioPub = apub as RemoteTrackPublication;
          break;
        }
      }
      return { participant: p, video: pub as RemoteTrackPublication, audio: audioPub };
    }
  }
  return null;
}

function refreshScreenShareSubscriptionsAfterMembershipChange(): void {
  // Drop queue entries whose publication no longer exists (publisher left
  // or stopped). Auto-subscribe newly-arrived publishers if we're under cap
  // and the user hasn't explicitly removed them.
  if (!room) {
    screenShareSubscriptionQueue.length = 0;
    return;
  }
  const allSids = new Set<string>();
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.videoTrackPublications.values()) {
      if (isScreenShareVideoPub(pub)) allSids.add(pub.trackSid);
    }
  }
  // Filter queue to surviving sids, preserving MRU order.
  for (let i = screenShareSubscriptionQueue.length - 1; i >= 0; i--) {
    const sid = screenShareSubscriptionQueue[i]!;
    if (!allSids.has(sid)) screenShareSubscriptionQueue.splice(i, 1);
  }
  // Auto-subscribe newcomers under cap (skip explicitly-unsubscribed).
  for (const sid of allSids) {
    if (screenShareSubscriptionQueue.includes(sid)) continue;
    if (explicitlyUnsubscribed.has(sid)) continue;
    if (screenShareSubscriptionQueue.length >= SCREEN_SHARE_SUBSCRIPTION_CAP) break;
    screenShareSubscriptionQueue.push(sid);
    const pubInfo = findScreenSharePubsByVideoSid(sid);
    if (pubInfo) {
      pubInfo.audio?.setSubscribed(true);
      pubInfo.video.setSubscribed(true);
    }
  }
  // Update channelPublisherCount on state.
  const cur = stateAccessor().screenShare ?? defaultScreenShareState();
  let count = 0;
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.videoTrackPublications.values()) {
      if (isScreenShareVideoPub(pub)) count++;
    }
  }
  // Include local publication.
  if (cur.publishStatus === "publishing") count++;
  if (count !== cur.channelPublisherCount) {
    setState({ screenShare: { ...cur, channelPublisherCount: count } });
  }
  pushScreenShareSubscriptions();
}

function defaultScreenShareState(): NonNullable<VoiceState["screenShare"]> {
  return {
    publishStatus: "idle",
    quality: "balanced",
    audioShared: false,
    channelMaxPublishers: SCREEN_SHARE_DEFAULT_MAX_PUBLISHERS,
    channelPublisherCount: 0,
    e2eeBlocked: false,
  };
}

// ---------------------------------------------------------------------------
// PR-6 — slot reservations from plugin iframes.
// ---------------------------------------------------------------------------

export function registerScreenSlot(input: {
  frameKey: string;
  iframe: HTMLIFrameElement;
  slotId: string;
  trackSid: string;
  rect: { x: number; y: number; width: number; height: number };
}): void {
  screenShareSlots.set(slotKey(input.frameKey, input.slotId), {
    frameKey: input.frameKey,
    iframe: input.iframe,
    slotId: input.slotId,
    trackSid: input.trackSid,
    rect: input.rect,
  });
  publishSlotsSignal();
}

export function updateScreenSlot(input: {
  frameKey: string;
  slotId: string;
  rect: { x: number; y: number; width: number; height: number };
}): void {
  const key = slotKey(input.frameKey, input.slotId);
  const existing = screenShareSlots.get(key);
  if (!existing) return;
  // Skip no-op updates so the signal doesn't churn.
  const r = existing.rect;
  if (
    r.x === input.rect.x &&
    r.y === input.rect.y &&
    r.width === input.rect.width &&
    r.height === input.rect.height
  ) {
    return;
  }
  screenShareSlots.set(key, { ...existing, rect: input.rect });
  publishSlotsSignal();
}

export function unregisterScreenSlot(input: {
  frameKey: string;
  slotId: string;
}): void {
  if (screenShareSlots.delete(slotKey(input.frameKey, input.slotId))) {
    publishSlotsSignal();
  }
}

// Sweep all slots owned by a specific frame — called when an iframe unmounts
// (channel-view.tsx cleanup). Avoids the TTL approach the plan rejects in
// edge case 32.
export function unregisterScreenSlotsForFrame(frameKey: string): void {
  let dirty = false;
  for (const key of Array.from(screenShareSlots.keys())) {
    const entry = screenShareSlots.get(key);
    if (entry && entry.frameKey === frameKey) {
      screenShareSlots.delete(key);
      dirty = true;
    }
  }
  if (dirty) publishSlotsSignal();
}

// ---------------------------------------------------------------------------
// PR-6 — admin moderation: kick the offending publisher via plugin SDK.
// Backend re-checks `voice.moderation.stop_share` permission (plan §"Files
// touched"); the manager only wires the IPC.
// ---------------------------------------------------------------------------

export async function adminStopScreenShare(input: {
  serverId: string;
  channelId: string;
  userId: string;
  reason?: string;
}): Promise<void> {
  try {
    await request<{ ok: true }>(
      input.serverId,
      "voice-channels",
      "voice.stopShare",
      {
        channelId: input.channelId,
        userId: input.userId,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushError("screen_share_permission_denied", message);
  }
}

// ---------------------------------------------------------------------------
// Iframe → manager dispatcher. Called from channel-view.tsx onMessage with
// the iframe's slug + serverId already resolved from closure (pin #1).
// ---------------------------------------------------------------------------

export function dispatch(args: {
  serverId: string;
  slug: string;
  envelope: VoiceRequest;
  /** PR-6 — postMessage frame identifier for slot ownership. Required for
   *  the slot envelopes; ignored otherwise. The shell already keys every
   *  iframe by `${activeId}:${panelId}:${surfaceKey}` (PR-5 §17 dispatch),
   *  so dispatch callers pass it through verbatim. */
  frameKey?: string;
  /** The iframe element the envelope arrived from. Used to anchor slot
   *  positioning by element identity rather than mount-key string, so
   *  cross-workspace drag's `portalHost.rekey` doesn't desync the overlay.
   *  Required alongside frameKey for the slot register envelope. */
  iframe?: HTMLIFrameElement;
}): void {
  const { serverId, slug, envelope, frameKey, iframe } = args;
  switch (envelope.type) {
    case "platform.voice.connect":
      void connect({
        serverId,
        slug,
        channelId: envelope.channelId,
        ...(envelope.channelName !== undefined ? { channelName: envelope.channelName } : {}),
      });
      return;
    case "platform.voice.disconnect":
      void disconnect();
      return;
    case "platform.voice.set-mic-muted":
      setMicMuted(envelope.muted);
      return;
    case "platform.voice.set-local-participant-muted":
      setLocalParticipantMuted(envelope.userId, envelope.muted);
      return;
    case "platform.voice.set-local-participant-volume":
      setLocalParticipantVolume(envelope.userId, envelope.volume);
      return;
    case "platform.voice.set-deafened":
      setDeafened(envelope.deafened);
      return;
    case "platform.voice.request-setup":
      // Voice plugin clicked a dimmed channel — fan out to setup-modal listeners
      // (see onRequestSetup). The shell modal owner-gates and renders.
      for (const fn of setupRequestListeners) fn(serverId);
      return;
    case "platform.voice.start-audio":
      void startAudio();
      return;
    // PR-6 — screen share dispatchers.
    case "platform.voice.start-screen-share":
      void startScreenShare({
        audio: envelope.audio,
        quality: envelope.quality,
        ...(envelope.sourceId !== undefined ? { sourceId: envelope.sourceId } : {}),
      });
      return;
    case "platform.voice.stop-screen-share":
      void stopScreenShare();
      return;
    case "platform.voice.set-screen-share-quality":
      void setScreenShareQuality(envelope.quality);
      return;
    case "platform.voice.subscribe-screen-share":
      void subscribeScreenShare(envelope.trackSid);
      return;
    case "platform.voice.unsubscribe-screen-share":
      unsubscribeScreenShare(envelope.trackSid);
      return;
    case "platform.voice.popout-screen-share":
      popoutScreenShare(envelope.trackSid);
      return;
    case "platform.voice.dock-screen-share":
      dockScreenShare(envelope.trackSid);
      return;
    case "platform.voice.set-screen-share-volume":
      setScreenShareVolume(envelope.trackSid, envelope.volumePct);
      return;
    case "platform.voice.mute-screen-share-audio":
      muteScreenShareAudio(envelope.trackSid, envelope.muted);
      return;
    case "platform.voice.register-screen-slot":
      // Drop slot envelopes that arrive without a frameKey or iframe — without
      // them the overlay can't disambiguate split-panel mounts or position the
      // <video>. Indicates a dispatch caller bug, not a runtime case worth
      // surfacing.
      if (frameKey === undefined || iframe === undefined) return;
      registerScreenSlot({
        frameKey,
        iframe,
        slotId: envelope.slotId,
        trackSid: envelope.trackSid,
        rect: envelope.rect,
      });
      return;
    case "platform.voice.update-screen-slot":
      if (frameKey === undefined) return;
      updateScreenSlot({
        frameKey,
        slotId: envelope.slotId,
        rect: envelope.rect,
      });
      return;
    case "platform.voice.unregister-screen-slot":
      if (frameKey === undefined) return;
      unregisterScreenSlot({ frameKey, slotId: envelope.slotId });
      return;
    case "platform.voice.admin-stop-screen-share":
      void adminStopScreenShare({
        serverId,
        channelId: envelope.channelId,
        userId: envelope.userId,
        ...(envelope.reason !== undefined ? { reason: envelope.reason } : {}),
      });
      return;
  }
}

// ---------------------------------------------------------------------------
// Room event wiring.
// ---------------------------------------------------------------------------

function parseAvatarFromMetadata(metadata: string | undefined): string {
  // The runtime packs avatar_url into the JWT `metadata` claim as JSON
  // `{"avatarUrl": "..."}` — keep parsing tolerant: malformed JSON, missing
  // field, or non-string values all collapse to "no avatar" so a buggy
  // mint never crashes the roster.
  if (typeof metadata !== "string" || metadata.length === 0) return "";
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (typeof parsed !== "object" || parsed === null) return "";
    const candidate = (parsed as Record<string, unknown>)["avatarUrl"];
    return typeof candidate === "string" ? candidate.trim() : "";
  } catch {
    return "";
  }
}

function snapshotParticipant(
  p: Participant,
  prevLocalMuted: Map<string, boolean>,
): ParticipantSnapshot {
  const pubs = Array.from(p.audioTrackPublications.values());
  const firstPub: TrackPublication | undefined = pubs[0];
  // LiveKit Participant.name is "" when no JWT name claim was set. For the
  // local participant we can patch from the shell's auth context — the
  // signed-in account's display_name is authoritative regardless of what
  // the JWT carried. Remote participants still rely on the JWT name claim
  // (the SFU broadcasts it from their token), so a missing display_name in
  // the runtime DB at mint time would surface as a UUID fallback.
  let name = typeof p.name === "string" ? p.name.trim() : "";
  if (name.length === 0 && p.isLocal) {
    const localName = account()?.display_name?.trim() ?? "";
    if (localName.length > 0) name = localName;
  }
  // Same story for avatarUrl: remote participants get it via the JWT
  // `metadata` claim (mint-time runtime lookup); local falls back to the
  // signed-in account so a fresh PFP shows up before the next mint.
  let avatarUrl = parseAvatarFromMetadata(p.metadata);
  if (avatarUrl.length === 0 && p.isLocal) {
    const localAvatar = account()?.avatar_url?.trim() ?? "";
    if (localAvatar.length > 0) avatarUrl = localAvatar;
  }
  const storedVolume = localVolumes.get(p.identity);
  // Pair screen-share video pubs with their audio peers (single audio per
  // participant in v1; the contract leaves the array shape open for multi).
  const videoPubs = Array.from(p.videoTrackPublications.values());
  let hasScreenShareAudio = false;
  for (const apub of pubs) {
    if (apub.source === "screen_share_audio") {
      hasScreenShareAudio = true;
      break;
    }
  }
  const screenSharePublications: ScreenSharePublication[] = [];
  for (const vpub of videoPubs) {
    if (vpub.source !== "screen_share") continue;
    screenSharePublications.push({
      trackSid: vpub.trackSid,
      hasAudio: hasScreenShareAudio,
      isPublishedByLocal: p.isLocal,
    });
  }
  return {
    userId: p.identity,
    identity: p.identity,
    ...(name.length > 0 ? { name } : {}),
    ...(avatarUrl.length > 0 ? { avatarUrl } : {}),
    isLocal: p.isLocal,
    micPublished: pubs.length > 0,
    micMuted: firstPub?.isMuted ?? false,
    localMuted: prevLocalMuted.get(p.identity) ?? false,
    ...(storedVolume !== undefined ? { localVolume: storedVolume } : {}),
    ...(screenSharePublications.length > 0 ? { screenSharePublications } : {}),
  };
}

function refreshParticipants(): void {
  if (!room) {
    setParticipants([]);
    pushParticipants();
    return;
  }
  const prevLocalMuted = new Map(participantsAccessor().map((p) => [p.userId, p.localMuted]));
  const snapshot: ParticipantSnapshot[] = [];
  snapshot.push(snapshotParticipant(room.localParticipant, prevLocalMuted));
  for (const remote of room.remoteParticipants.values()) {
    snapshot.push(snapshotParticipant(remote, prevLocalMuted));
  }
  setParticipants(snapshot);
  pushParticipants();
}

// Throttle ActiveSpeakersChanged to ≤5/sec per §3c. Leading-edge first push
// (no perceptible "talking indicator lag" at the start of an utterance),
// trailing-edge for subsequent within-window changes (still capped at 5/sec).
const ACTIVE_SPEAKERS_WINDOW_MS = 200;
let activeSpeakersTrailing: string[] | null = null;
let activeSpeakersTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleActiveSpeakers(ids: string[]): void {
  if (activeSpeakersTimer === null) {
    // Leading edge — push immediately, then open the throttle window.
    setActiveSpeakerIds(ids);
    pushActiveSpeakers();
    activeSpeakersTrailing = null;
    activeSpeakersTimer = setTimeout(() => {
      activeSpeakersTimer = null;
      if (activeSpeakersTrailing === null) return;
      const next = activeSpeakersTrailing;
      activeSpeakersTrailing = null;
      setActiveSpeakerIds(next);
      pushActiveSpeakers();
    }, ACTIVE_SPEAKERS_WINDOW_MS);
    return;
  }
  // Within an open window — store the latest only; timer flushes on close.
  activeSpeakersTrailing = ids;
}

function mapDisconnectReason(
  reason: DisconnectReasonType | undefined,
  lk: LivekitModule,
): VoiceReason {
  if (reason === undefined) return "network";
  const R = lk.DisconnectReason;
  if (reason === R.CLIENT_INITIATED) return "explicit";
  // TODO(PR-5.5): once role-change kicks land via cascade
  // (`runtime/src/voice/room-service.ts`), distinguish bans from kicks here —
  // both currently land as PARTICIPANT_REMOVED with no client-side signal to
  // tell them apart. PR-5 only emits this on ban, so the lossy mapping is
  // safe today.
  if (reason === R.PARTICIPANT_REMOVED) return "server_ban";
  if (reason === R.DUPLICATE_IDENTITY) return "identity_collision";
  if (reason === R.ROOM_DELETED) return "room_destroyed";
  return "network";
}

// Detects identity collision surfaced as a `Room.connect()` rejection (LiveKit
// signal-channel Leave before the join resolves) rather than the post-connect
// Disconnected event. Tested empirically against livekit-client 2.18.7:
// `ConnectionError` with `reason === LeaveRequest` and `context ===
// DUPLICATE_IDENTITY`.
function isDuplicateIdentityError(err: unknown, lk: LivekitModule): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; reason?: number; context?: unknown };
  if (e.name !== "ConnectionError") return false;
  const Reasons = lk.ConnectionErrorReason;
  if (e.reason !== Reasons.LeaveRequest) return false;
  return e.context === lk.DisconnectReason.DUPLICATE_IDENTITY;
}

function wireRoomEvents(r: Room, lk: LivekitModule): void {
  const E: typeof RoomEventType = lk.RoomEvent;

  r.on(E.Connected, () => {
    refreshParticipants();
  });

  r.on(E.Disconnected, (reason) => {
    if (room !== r) return;
    const mapped = mapDisconnectReason(reason, lk);
    room = null;
    setActiveRoomSignal(null);
    setParticipants([]);
    setActiveSpeakerIds([]);
    setConnectedAt(null);
    // PR-6 — server-initiated teardown wipes screen-share session state.
    // Mirrors disconnect()/teardownOnUnload() so a network drop, kick, or
    // identity collision doesn't leak a stale LRU/popout/slot map into
    // the next connect.
    screenShareSubscriptionQueue.length = 0;
    explicitlyUnsubscribed.clear();
    screenShareAudioVolumes.clear();
    screenShareAudioLocalMuted.clear();
    screenSharePoppedOut.clear();
    screenShareSlots.clear();
    publishSlotsSignal();
    inFlightStartShare = null;
    if (mapped === "identity_collision") {
      pushError("identity_collision", "Already connected from another tab.");
      setState({
        status: "failed",
        reason: mapped,
        error: { code: "identity_collision", message: "Already connected from another tab." },
      });
      return;
    }
    setState({
      status: mapped === "explicit" ? "disconnected" : "failed",
      reason: mapped,
      mic: { available: false, muted: false, serverMuted: false },
      audioPlaybackBlocked: false,
    });
  });

  r.on(E.Reconnecting, () => {
    if (room !== r) return;
    setState({ status: "reconnecting" });
  });

  r.on(E.Reconnected, () => {
    if (room !== r) return;
    setState({ status: "connected" });
    refreshParticipants();
  });

  r.on(E.ParticipantConnected, () => {
    refreshParticipants();
    refreshScreenShareSubscriptionsAfterMembershipChange();
  });
  r.on(E.ParticipantDisconnected, () => {
    refreshParticipants();
    refreshScreenShareSubscriptionsAfterMembershipChange();
  });
  r.on(E.TrackPublished, () => {
    refreshParticipants();
    refreshScreenShareSubscriptionsAfterMembershipChange();
  });
  r.on(E.TrackUnpublished, () => {
    refreshParticipants();
    refreshScreenShareSubscriptionsAfterMembershipChange();
  });
  r.on(E.LocalTrackPublished, (pub: LocalTrackPublication) => {
    refreshParticipants();
    if (pub.source === "screen_share") {
      // Recompute publisher count + propagate state including local pub.
      refreshScreenShareSubscriptionsAfterMembershipChange();
    }
  });
  r.on(E.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
    refreshParticipants();
    if (pub.source === "screen_share") {
      refreshScreenShareSubscriptionsAfterMembershipChange();
    }
  });
  r.on(E.TrackMuted, (_pub, p: Participant) => {
    if (p.isLocal) {
      // Local mute event — could be user-initiated or server-mute. We can't
      // distinguish from the client; serverMuted stays false until §16 lands
      // and the runtime explicitly pushes a server-mute signal.
      setState({ mic: { ...stateAccessor().mic, muted: true } });
    }
    refreshParticipants();
  });
  r.on(E.TrackUnmuted, (_pub, p: Participant) => {
    if (p.isLocal) {
      setState({ mic: { ...stateAccessor().mic, muted: false } });
    }
    refreshParticipants();
  });
  // Remote audio attach. LiveKit JS does NOT auto-create <audio> elements for
  // subscribed remote tracks — without an explicit attach() the SDK has the
  // MediaStream but nothing in the DOM to play it, so listeners hear silence
  // even though the SFU is delivering packets and the participant is audible
  // on the publishing side. Element lives in the shell document (not the
  // sandboxed plugin iframe) so the AudioBlockedBanner click can satisfy
  // iOS Safari's user-activation requirement on it.
  //
  // No `room !== r` guard here: TrackSubscribed fires synchronously during
  // `await newRoom.connect()` for participants already in the room, BEFORE
  // the caller assigns `room = newRoom`. Guarding on the global would skip
  // those attaches and produce asymmetric audio (the late joiner never hears
  // the early joiner). The handler is closed over `r`; if this room is later
  // disconnected, `r.disconnect()` fires TrackUnsubscribed which detaches.
  r.on(E.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: Participant) => {
    // Screen-share video — the overlay component owns DOM attach (it
    // calls track.attach() against its <video> element). The manager
    // doesn't append a hidden <video> here because that'd cost a second
    // decoder run for every active subscription. Just refresh roster +
    // subscriptions so the plugin sees the new stream-paused/subscribed
    // signal.
    if (track.kind === "video" && pub.source === "screen_share") {
      // The overlay's shapes memo resolves the RemoteVideoTrack lazily via
      // findScreenShareVideoTrack. Slot registration races ahead of this
      // event, so the first shapes() pass produces track=null. Bump the
      // version signal so the memo re-runs and the overlay can attach the
      // freshly-delivered MediaStream.
      bumpScreenShareTrackVersion();
      pushScreenShareSubscriptions();
      refreshParticipants();
      return;
    }
    if (track.kind !== "audio") return;
    const el = track.attach();
    el.style.display = "none";
    document.body.appendChild(el);
    // Per-track listener volume policy:
    //   - mic peer: per-participant `localVolumes` (existing semantics).
    //   - screen-share-audio peer: per-trackSid map keyed by the paired
    //     video sid (atomic coupling, plan §5).
    if (pub.source === "screen_share_audio") {
      // Find the paired video pub on this same participant — the audio
      // map keys off the video sid so plugins control "share volume" per
      // tile rather than per peer track.
      let pairedVideoSid: string | null = null;
      for (const candidate of (p as RemoteParticipant).videoTrackPublications.values()) {
        if (isScreenShareVideoPub(candidate)) {
          pairedVideoSid = candidate.trackSid;
          break;
        }
      }
      const audio = track as unknown as { setVolume?: (v: number) => void };
      if (typeof audio.setVolume === "function") {
        const muted = pairedVideoSid !== null && screenShareAudioLocalMuted.has(pairedVideoSid);
        const stored =
          (pairedVideoSid !== null
            ? screenShareAudioVolumes.get(pairedVideoSid)
            : undefined) ?? 1;
        audio.setVolume(muted ? 0 : stored);
      }
      pushScreenShareSubscriptions();
      return;
    }
    // Re-apply the user's listener-side volume in case they set one before
    // this track was subscribed (republish, late-join, etc.). Deafen wins
    // over the per-user value: target = 0 while deafened.
    const stored = localVolumes.get(p.identity) ?? 1;
    const target = stateAccessor().deafened ? 0 : stored;
    const audio = track as unknown as { setVolume?: (v: number) => void };
    if (typeof audio.setVolume === "function") {
      audio.setVolume(target);
    }
  });
  r.on(E.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication) => {
    if (track.kind === "video" && pub.source === "screen_share") {
      // Overlay's onCleanup calls detach(); but defensive cleanup here
      // ensures any orphaned attachments (HMR, React-style remount races)
      // get removed. detach() with no arg removes from every attached el.
      const v = track as unknown as { detach: () => HTMLMediaElement[] };
      v.detach().forEach((el) => el.remove());
      bumpScreenShareTrackVersion();
      pushScreenShareSubscriptions();
      return;
    }
    if (track.kind !== "audio") return;
    track.detach().forEach((el) => {
      el.remove();
    });
    if (pub.source === "screen_share_audio") {
      pushScreenShareSubscriptions();
    }
  });

  // Dynacast: SFU pauses non-visible layers under bandwidth pressure;
  // surfaced via `TrackStreamStateChanged`. Plugins overlay a "Stream
  // paused — click to resume" affordance based on the pushed
  // subscription envelope.
  r.on(E.TrackStreamStateChanged, (pub: RemoteTrackPublication) => {
    if (!isScreenShareVideoPub(pub)) return;
    pushScreenShareSubscriptions();
  });

  r.on(E.ActiveSpeakersChanged, (speakers) => {
    if (room !== r) return;
    scheduleActiveSpeakers(speakers.map((s) => s.identity));
  });

  // Browsers block autoplay when the user gesture happened in an iframe that
  // isn't the document that hosts the LiveKit `<audio>` elements. LiveKit
  // surfaces the blocked state via `canPlaybackAudio` and fires this event
  // when it flips. We mirror it onto VoiceState so plugins can render an
  // "Enable audio" affordance whose click runs `startAudio()` from a fresh
  // user gesture in the right document.
  r.on(E.AudioPlaybackStatusChanged, () => {
    if (room !== r) return;
    setState({ audioPlaybackBlocked: !r.canPlaybackAudio });
  });
}

// ---------------------------------------------------------------------------
// Autoplay unblock — called from the iframe via `platform.voice.start-audio`.
// Must be invoked synchronously from a user gesture; LiveKit's startAudio()
// resumes the AudioContext and (re)attaches blocked `<audio>` elements.
// ---------------------------------------------------------------------------

export async function startAudio(): Promise<void> {
  const r = room;
  if (!r) return;
  try {
    await r.startAudio();
  } catch (err) {
    // Failure is rare — typically a stale gesture. Surface it so the plugin
    // can keep the affordance visible and the user can try again.
    const message = err instanceof Error ? err.message : String(err);
    pushError("livekit_unreachable", `Audio playback could not be resumed: ${message}`);
    return;
  }
  // The AudioPlaybackStatusChanged listener will flip the flag once playback
  // actually starts. Race-safe: if it's already false on the room, mirror it.
  if (room === r) setState({ audioPlaybackBlocked: !r.canPlaybackAudio });
}

// ---------------------------------------------------------------------------
// Document-level cleanup hooks (§7).
// ---------------------------------------------------------------------------

function teardownOnUnload(): void {
  // Always cancel any in-flight attempt — even if `room` is null we may be
  // mid-handshake (token mint pending, livekit lazy-loading) and the page
  // going away should drop the wait. Without this, a hidden-during-handshake
  // path leaks an attempt past the visibility-deferred timer.
  attemptId++;
  if (attemptAbort) {
    attemptAbort.abort();
    attemptAbort = null;
  }
  lastConnect = null;
  const r = room;
  room = null;
  setActiveRoomSignal(null);
  if (r) {
    // Synchronous best-effort: room.disconnect() schedules the Leave on the
    // existing WS; we don't await because pagehide/beforeunload won't honor it.
    void r.disconnect();
  }
  // Update the public state too. If the page was put into bfcache and then
  // restored, the document keeps living and any UI subscriber would otherwise
  // still see status: "connected" while the LiveKit Room is gone — silent
  // desync. Push a clean disconnected state so the indicator dismisses on
  // restore. (For real navigation/close paths the state push is a no-op
  // because the document is going away anyway.)
  setStateRaw((prev) => {
    const next: VoiceState = {
      ...prev,
      status: "disconnected",
      serverId: null,
      channelId: null,
      mic: { available: false, muted: false, serverMuted: false },
    };
    delete next.channelName;
    delete next.error;
    delete next.deafened;
    next.reason = "explicit";
    return next;
  });
  setParticipants([]);
  setActiveSpeakerIds([]);
  setConnectedAt(null);
  localVolumes.clear();
  preDeafenMicMuted = null;
  // PR-6 — clear screen-share session state so a bfcache restore or a
  // pagehide-under-active-share doesn't leave a dangling LRU/popout/slot
  // map across the next mount.
  screenShareSubscriptionQueue.length = 0;
  explicitlyUnsubscribed.clear();
  screenShareAudioVolumes.clear();
  screenShareAudioLocalMuted.clear();
  screenSharePoppedOut.clear();
  publishPoppedOutSignal();
  screenShareSlots.clear();
  publishSlotsSignal();
  inFlightStartShare = null;
  pushState();
}

// Defer-and-cancel teardown on visibility-hidden. Naively tearing down on
// every hidden event would disconnect users from voice every time they
// switch browser tabs (Discord-non-parity, painful regression). Instead:
//   - On hidden: arm a 60s timer. If the page is still hidden when it fires
//     (i.e. user really left — closed app, bfcache, mobile-Safari unload),
//     run the teardown.
//   - On visible: cancel the pending timer. Tab-switch is the common case
//     and shouldn't disturb the room.
// 60s comfortably exceeds typical tab-switch cycles (seconds) while still
// firing before LiveKit's own server-side zombie-participant timeout (30-60s)
// for the "user really closed the app" flow. UA-agnostic — works on every
// browser, including Mobile Safari which §7 originally listed as the
// motivating case.
const VISIBILITY_TEARDOWN_DELAY_MS = 60_000;
let visibilityTeardownTimer: ReturnType<typeof setTimeout> | null = null;

function onVisibilityChange(): void {
  if (typeof document === "undefined") return;
  if (document.visibilityState === "hidden") {
    // PR-6 — never arm the teardown timer while actively publishing screen
    // share. Sharing "Entire Screen" or a foreground window typically pushes
    // UnCorded behind the captured surface (Electron + Chromium report
    // visibilityState=hidden for occluded windows), and 60s later the timer
    // would kill the room mid-broadcast — exactly the wrong behavior. The
    // user is intentionally engaged; if they truly leave, the WS and WebRTC
    // streams die naturally and LiveKit's zombie-participant timeout cleans
    // up server-side.
    const ss = stateAccessor().screenShare;
    if (ss && (ss.publishStatus === "publishing" || ss.publishStatus === "starting")) {
      return;
    }
    if (visibilityTeardownTimer !== null) return;
    visibilityTeardownTimer = setTimeout(() => {
      visibilityTeardownTimer = null;
      teardownOnUnload();
    }, VISIBILITY_TEARDOWN_DELAY_MS);
    return;
  }
  // visible — user came back; cancel the pending teardown.
  if (visibilityTeardownTimer !== null) {
    clearTimeout(visibilityTeardownTimer);
    visibilityTeardownTimer = null;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", teardownOnUnload);
  window.addEventListener("beforeunload", teardownOnUnload);
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", onVisibilityChange);
}

// Dev-only handle for the singleton-cardinality smoke test (§13). Importing
// this module from anywhere returns the same instance; this is just an
// additional verification surface.
if (typeof window !== "undefined" && import.meta.env.DEV) {
  (window as unknown as { __voiceManager?: unknown }).__voiceManager = {
    state,
    participants,
    activeSpeakerIds,
    connect,
    disconnect,
    setMicMuted,
    setDeafened,
    setLocalParticipantVolume,
    setLocalParticipantMuted,
    retry,
    // Screen-share debugging surface — exposed so the dev console can verify
    // slot registration, popped-out state, and the room's remote pubs without
    // having to re-import the module.
    screenShareSlots: () => Array.from(screenShareSlots.values()),
    screenSharePoppedOut: () => Array.from(screenSharePoppedOut),
    screenShareSubscriptionQueue: () => screenShareSubscriptionQueue.slice(),
    activeRoom: () => room,
    debugScreenShare: () => {
      const r = room;
      const remotes: Record<string, unknown> = {};
      if (r) {
        for (const p of r.remoteParticipants.values()) {
          const pubs: Record<string, unknown> = {};
          for (const pub of p.videoTrackPublications.values()) {
            pubs[pub.trackSid] = {
              source: pub.source,
              isSubscribed: pub.isSubscribed,
              hasVideoTrack: !!pub.videoTrack,
              streamState: pub.track?.streamState,
            };
          }
          remotes[p.identity] = pubs;
        }
      }
      return {
        slots: Array.from(screenShareSlots.values()),
        queue: screenShareSubscriptionQueue.slice(),
        poppedOut: Array.from(screenSharePoppedOut),
        remoteScreenShares: remotes,
      };
    },
  };
}
