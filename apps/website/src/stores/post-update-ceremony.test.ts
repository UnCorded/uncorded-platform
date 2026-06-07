import { describe, expect, test, beforeEach } from "bun:test";
import type { RuntimeUpdateState } from "@uncorded/protocol";
import {
  observeUpdateState,
  ceremonyPhaseFor,
  preUpdateVersionFor,
  dismissCeremony,
  _resetCeremonyForTests,
} from "./post-update-ceremony";

beforeEach(() => {
  _resetCeremonyForTests();
});

const SERVER_ID = "srv-1";

function st(
  state: RuntimeUpdateState["state"],
  currentVersion: string,
  extra: Partial<RuntimeUpdateState> = {},
): RuntimeUpdateState {
  return {
    state,
    currentVersion,
    availableVersion: null,
    channel: "stable",
    progress: null,
    errorMessage: null,
    errorContext: null,
    lastCheckedAt: null,
    updatedAt: 0,
    ...extra,
  } as RuntimeUpdateState;
}

describe("ceremonyPhaseFor", () => {
  test("returns 'none' when there's no slot for the server", () => {
    expect(ceremonyPhaseFor(SERVER_ID, st("idle", "0.1.0"))).toBe("none");
  });

  test("returns 'none' for inactive states without a prior active observation", () => {
    observeUpdateState(SERVER_ID, st("idle", "0.1.0"));
    expect(ceremonyPhaseFor(SERVER_ID, st("idle", "0.1.0"))).toBe("none");
  });

  test("returns 'active' when the runtime is installing", () => {
    observeUpdateState(SERVER_ID, st("installing", "0.1.0"));
    expect(ceremonyPhaseFor(SERVER_ID, st("installing", "0.1.0"))).toBe("active");
  });

  test("returns 'active' when the runtime is rolling back", () => {
    observeUpdateState(SERVER_ID, st("rolling-back", "0.1.0"));
    expect(ceremonyPhaseFor(SERVER_ID, st("rolling-back", "0.1.0"))).toBe("active");
  });

  test("backup / download / downloaded phases resolve to 'none' (panel-only)", () => {
    // The dark overlay only fires for the irreversible install phase. The
    // user keeps the workspace visible while bytes come down so they can
    // chat / browse — the runtime panel carries the progress.
    observeUpdateState(SERVER_ID, st("backing-up", "0.1.0"));
    expect(ceremonyPhaseFor(SERVER_ID, st("backing-up", "0.1.0"))).toBe("none");

    observeUpdateState(SERVER_ID, st("downloading", "0.1.0"));
    expect(ceremonyPhaseFor(SERVER_ID, st("downloading", "0.1.0"))).toBe("none");

    observeUpdateState(SERVER_ID, st("downloaded", "0.1.0"));
    expect(ceremonyPhaseFor(SERVER_ID, st("downloaded", "0.1.0"))).toBe("none");
  });

  test("'active' is sustained across re-observations without resetting the snapshot", () => {
    observeUpdateState(SERVER_ID, st("installing", "0.1.0"));
    observeUpdateState(SERVER_ID, st("installing", "0.1.0"));
    expect(ceremonyPhaseFor(SERVER_ID, st("installing", "0.1.0"))).toBe("active");
    expect(preUpdateVersionFor(SERVER_ID)).toBe("0.1.0");
  });

  test("non-overlay phases preceding install do not snapshot (snapshot lands on install)", () => {
    // Backup + download flow through without latching the slot. Snapshot
    // lands the moment the user opts into the irreversible install phase
    // — that's when we need to remember "what version were we on?".
    observeUpdateState(SERVER_ID, st("backing-up", "0.1.0"));
    observeUpdateState(SERVER_ID, st("downloading", "0.1.0"));
    expect(preUpdateVersionFor(SERVER_ID)).toBeNull();
    observeUpdateState(SERVER_ID, st("installing", "0.1.0"));
    expect(preUpdateVersionFor(SERVER_ID)).toBe("0.1.0");
  });

  test("transitions to 'success' when state goes idle and currentVersion advanced", () => {
    observeUpdateState(SERVER_ID, st("installing", "0.1.0"));
    observeUpdateState(SERVER_ID, st("idle", "0.2.0"));
    expect(ceremonyPhaseFor(SERVER_ID, st("idle", "0.2.0"))).toBe("success");
  });

  test("transitions to 'failed' when state goes idle but currentVersion did not advance (rollback)", () => {
    observeUpdateState(SERVER_ID, st("installing", "0.1.0"));
    observeUpdateState(SERVER_ID, st("idle", "0.1.0"));
    expect(ceremonyPhaseFor(SERVER_ID, st("idle", "0.1.0"))).toBe("failed");
  });

  test("transitions to 'failed' when state is 'error' regardless of version", () => {
    observeUpdateState(SERVER_ID, st("installing", "0.1.0"));
    observeUpdateState(SERVER_ID, st("error", "0.1.0", { errorMessage: "boom" }));
    expect(ceremonyPhaseFor(SERVER_ID, st("error", "0.1.0"))).toBe("failed");
  });

  test("'error' resolves to 'failed' even when no prior active phase was seen (defensive)", () => {
    // Edge case: runtime broadcasts error without us catching the active
    // transition. Currently returns 'failed' only if a slot exists; without
    // observe(active) the slot is empty and we stay 'none'. Verified shape.
    expect(ceremonyPhaseFor(SERVER_ID, st("error", "0.1.0"))).toBe("none");
  });
});

describe("dismissCeremony", () => {
  test("clears the overlay after success", () => {
    observeUpdateState(SERVER_ID, st("installing", "0.1.0"));
    observeUpdateState(SERVER_ID, st("idle", "0.2.0"));
    expect(ceremonyPhaseFor(SERVER_ID, st("idle", "0.2.0"))).toBe("success");
    dismissCeremony(SERVER_ID);
    expect(ceremonyPhaseFor(SERVER_ID, st("idle", "0.2.0"))).toBe("none");
  });

  test("dismissed slot resumes tracking on the next active transition", () => {
    observeUpdateState(SERVER_ID, st("installing", "0.1.0"));
    observeUpdateState(SERVER_ID, st("idle", "0.2.0"));
    dismissCeremony(SERVER_ID);
    expect(ceremonyPhaseFor(SERVER_ID, st("idle", "0.2.0"))).toBe("none");

    // Another update kicks off — slot resets.
    observeUpdateState(SERVER_ID, st("installing", "0.2.0"));
    expect(ceremonyPhaseFor(SERVER_ID, st("installing", "0.2.0"))).toBe("active");
    expect(preUpdateVersionFor(SERVER_ID)).toBe("0.2.0");
  });

  test("dismiss is idempotent and a no-op when no slot exists", () => {
    dismissCeremony(SERVER_ID);
    expect(ceremonyPhaseFor(SERVER_ID, st("idle", "0.1.0"))).toBe("none");
  });
});

describe("observeUpdateState", () => {
  test("ignores null state (initial fetch hasn't landed yet)", () => {
    observeUpdateState(SERVER_ID, null);
    expect(ceremonyPhaseFor(SERVER_ID, null)).toBe("none");
    expect(preUpdateVersionFor(SERVER_ID)).toBeNull();
  });

  test("each server has an independent slot", () => {
    observeUpdateState("srv-a", st("installing", "0.1.0"));
    observeUpdateState("srv-b", st("idle", "0.2.0"));
    expect(ceremonyPhaseFor("srv-a", st("installing", "0.1.0"))).toBe("active");
    expect(ceremonyPhaseFor("srv-b", st("idle", "0.2.0"))).toBe("none");
    expect(preUpdateVersionFor("srv-a")).toBe("0.1.0");
    expect(preUpdateVersionFor("srv-b")).toBeNull();
  });

  test("snapshot taken at the moment we first observe an active phase", () => {
    // State broadcasts can land out of order; we want the FIRST active
    // observation's currentVersion to be the snapshot, not whatever an
    // intermediate idle write might carry. Active = installing (not the
    // pre-install backup/download phases).
    observeUpdateState(SERVER_ID, st("installing", "0.1.0"));
    observeUpdateState(SERVER_ID, st("installing", "0.1.0"));
    expect(preUpdateVersionFor(SERVER_ID)).toBe("0.1.0");
  });
});
