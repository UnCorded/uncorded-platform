# Phase 01 — Update UX Spec

> **Scope:** Operator-facing UX for runtime updates. Pairs with `runtime-lifecycle.md` (technical contract). Reflects decisions D1–D6 and O1–O8 in `decisions.md`. **No implementation in this doc** — this is the contract Stage 5 + Stage 6 build against.

---

## 1 · Mental model

- The **runtime** is a passive update-state store. It records the latest state and broadcasts transitions over WS. It does not pull, swap, or rollback itself.
- The **orchestrator** (desktop today, possibly UnCorded-hosted later — see D3) owns the lifecycle: pulls images, drains, swaps, rolls back, writes state into the runtime.
- **All clients** see the same state via WS. The install button is gated to `clientIsOrchestrator AND hasPermission("core.runtime.update")` (see D4, D5).

This split is the whole reason the UX has both a **pill** (universal, informational) and a **panel** (action surface, conditional).

## 2 · State machine

### 2.1 States

Twelve states. The first eight match desktop's existing `UpdateStatus` (`apps/desktop/src/auto-update.ts`); the last four are runtime-specific.

| State | Meaning | Pill visible? | Pill color | Pill tooltip |
| --- | --- | --- | --- | --- |
| `disabled` | Updates turned off (manual-only mode for compose users) | no | — | — |
| `idle` | Not currently checking; last result clean | no | — | — |
| `checking` | Auto- or manual-triggered check in flight | no | — | — |
| `up-to-date` | Confirmed current within last check window | no | — | — |
| `available` | New version exists; awaiting owner/admin action | **yes** | amber-500 + pulse | "Update available — vX.Y.Z" |
| `pending-confirm` | User clicked Update, typing confirmation; orchestrator hasn't started yet | **yes** | amber-500 + pulse | "Confirm to install vX.Y.Z" |
| `backing-up` | Pre-update state-dir snapshot in progress (per O3) | **yes** | sky-400 + pulse | "Backing up before update…" |
| `downloading` | Orchestrator pulling new image | **yes** | sky-400 + pulse | "Downloading vX.Y.Z — N%" |
| `downloaded` | Image local; ready to install (drain + swap) | **yes** | emerald-500 | "vX.Y.Z ready to install" |
| `installing` | Drain → swap → boot in progress | **yes** | sky-400 + pulse | "Installing vX.Y.Z…" |
| `rolling-back` | Health check post-swap failed; restoring `:previous` | **yes** | red-400 + pulse | "Update failed — rolling back" |
| `error` | Terminal failure; needs operator decision | **yes** | red-400 | error-context-specific copy |

### 2.2 Error contexts

`errorContext` extends desktop's set with backup + rollback paths:

```ts
type ErrorContext =
  | "check"      // failed to query update channel
  | "backup"     // snapshot before update failed
  | "download"   // pull failed
  | "install"    // drain or swap failed
  | "rollback"   // rollback itself failed (worst case)
  | null;
```

- `check`, `backup`, `download` errors are **retryable** — pill stays red-400, panel offers "Retry."
- `install` errors auto-trigger `rolling-back`. Operator sees the rollback state, then either `idle` (rollback succeeded) or `error/rollback` (rollback failed).
- `rollback` errors are the **escalation** state. Panel says "Manual recovery required" + link to logs + reference to runbook. No retry button.

### 2.3 Transitions

```
idle ──check─→ checking ──result─→ up-to-date | available | error/check
available ──user clicks Update──→ pending-confirm
pending-confirm ──types UPDATE──→ backing-up
pending-confirm ──cancels──→ available
backing-up ──ok──→ downloading
backing-up ──fail──→ error/backup
downloading ──ok──→ downloaded
downloading ──fail──→ error/download
downloaded ──auto, after grace──→ installing
installing ──post-swap health ok──→ idle (now on new version)
installing ──post-swap health fail──→ rolling-back
rolling-back ──ok──→ idle (still on prior version)
rolling-back ──fail──→ error/rollback
error/* ──user clicks Retry──→ checking | backing-up | downloading
error/rollback ──no retry──→ (manual operator action)
```

### 2.4 Wire format

Runtime broadcasts `update_state_changed` over the existing admin WS topic:

```ts
type UpdateStateBroadcast = {
  type: "update_state_changed";
  state: UpdateStatus;
  errorContext: ErrorContext;
  currentVersion: string;        // sourced from build (Stage 3 hygiene)
  availableVersion: string | null;
  channel: "stable" | "beta" | "dev";    // per O2
  progress: number | null;       // 0..100, 10% buckets
  lastCheckedAt: number;         // epoch ms
  errorMessage: string | null;   // one-line, user-safe; full detail via /admin/api/update-log
  updatedAt: number;             // epoch ms; written by runtime on every persist (matches runtime-lifecycle.md §12)
};
```

Bucketed progress at 10% (matching desktop) keeps the broadcast frequency sane.

## 3 · Sidebar pill

### 3.1 Where it goes

Replaces the connection-status icon in two locations:

- `platform/apps/website/src/components/server-switcher.tsx:160-162` (server selector header)
- `platform/apps/website/src/components/app-sidebar.tsx:73-75` (sidebar status slot)

Behavior:
- When pill is visible (states above), it **replaces** `Wifi`/`WifiOff`. Connection state degrades to a dot indicator combined with the pill icon, or is omitted while the update pill is present (final call in implementation).
- When pill is not visible (`disabled`, `idle`, `checking`, `up-to-date`), the existing Wifi/WifiOff renders as today.

### 3.2 Visual

- Icon: `Rocket` from `lucide-solid`, `class="size-3"` (matches the slot's existing icon scale, not size-4 — sidebar size).
- Color comes from the table in §2.1.
- Pulse animation reuses `--animate-update-pulse` already defined in `platform/apps/website/src/index.css:38, 112` (no new keyframes).
- Tooltip uses the table copy. For `error` and `downloading`, copy is dynamic.

### 3.3 Click behavior

Click → `navigate("/servers/:serverId/settings/danger")` (see D6 routes).

If the user is already on Danger Zone, click smooth-scrolls to the Runtime panel section and momentarily highlights its border (1.5s amber outline ring).

### 3.4 Permission and orchestrator gates

The pill renders for **all clients regardless of role or orchestrator status**. Visibility is the universal half of D4. Click target is the same regardless of who clicks — non-admins land on Danger Zone and see informational copy in the panel, not the action button (§4.5).

## 4 · Danger Zone — Runtime panel

### 4.1 Layout

In `Server Settings → Danger Zone`, add a top section "Runtime update" before the existing destructive actions. Two-column on desktop, stacked on mobile:

- **Left column:** Current version, channel, last checked timestamp + manual refresh icon.
- **Right column:** Contextual action button (mutates by state, see §4.4) and inline messaging.

Below the two columns: collapsible release notes section (only when `availableVersion` is non-null). External link to the release page on UnCorded's release repo (per `reference_release_pipeline.md`).

### 4.2 Header line

```
Runtime · vX.Y.Z · channel: stable
Last checked: 4m ago  ⟳
```

- `⟳` = `RefreshCw` from `lucide-solid`, `class="size-3"`. Click triggers a fresh check (transitions runtime to `checking`). Disabled while `checking`, `backing-up`, `downloading`, `installing`, or `rolling-back`.
- Manual check is a **defensive feature** — auto-check failures (silent or otherwise) shouldn't strand a user.

### 4.3 Channel switcher

Inline `<select>`: `stable | beta | dev`. Changing it:
1. POSTs new channel to runtime.
2. Triggers an immediate recheck.
3. Updates the broadcast `channel` field; all clients re-render.

Disabled during any non-terminal state (don't let operator switch channels mid-install).

### 4.4 Contextual button

The button area is **one slot** that mutates by state. No modals — confirmation expands inline.

| State | Button label | Button color | Helper text below |
| --- | --- | --- | --- |
| `up-to-date` | (no button) | — | "You're on the latest version." |
| `available` | "Update to vX.Y.Z" | amber | "Update available. Click to begin." |
| `pending-confirm` | (button replaced by inline confirm form, see §4.6) | — | — |
| `backing-up` | "Backing up…" (disabled) | sky | "Snapshotting state directory…" |
| `downloading` | "Downloading… N%" (disabled) | sky | "Pulling vX.Y.Z." |
| `downloaded` | "Install now" | emerald | "vX.Y.Z downloaded. Connected users will be notified before drain." |
| `installing` | "Installing…" (disabled) | sky | "Draining connections, swapping container, booting new version." |
| `rolling-back` | "Rolling back…" (disabled) | red | "Post-update health check failed. Restoring previous version." |
| `error` (`check`/`backup`/`download`) | "Retry" | red | error-context-specific message + link to logs |
| `error` (`install`) | (not directly reachable — auto transitions to `rolling-back`) | — | — |
| `error` (`rollback`) | (no button) | — | "Manual recovery required. See [logs] and the recovery runbook. Container may be in a partial state." |

All disabled states preserve the slot's height so the layout doesn't jump.

### 4.5 Off-orchestrator and no-permission rendering

Per D4, the action button only renders when both predicates are true:
- `clientIsOrchestrator` — the host environment advertises orchestrator capability (desktop sets via IPC; web/mobile do not).
- `hasPermission("core.runtime.update")` — the role check from D5.

When **either is false**, the right column shows an informational box instead of the button:

- **Has permission, off-orchestrator (e.g. owner viewing from web):**
  > "Updates can only be installed from the orchestrator (currently: desktop app on _hostname_). Open this server's settings on the orchestrator device to install."

- **No permission (any role below admin):**
  > "Update available. Ask the server owner or an admin to install."

Both copies still show current/available version + release notes link. State transitions still render in real time (pill, helper text) — the user just can't act.

### 4.6 Inline UPDATE confirmation (state: `pending-confirm`)

When user clicks "Update to vX.Y.Z" from state `available`:

1. The button slot expands in place (no modal).
2. Reveals:
   - One-line warning: "Connected users will be disconnected during install. Auto-rollback engages on health check failure."
   - Text input with placeholder "Type UPDATE to confirm".
   - Two buttons: **Confirm** (disabled until exact match `UPDATE`) and **Cancel**.
3. On Confirm: POST to runtime → orchestrator picks up the state transition → moves to `backing-up`.
4. On Cancel: POST to runtime → state returns to `available`, slot collapses back to the "Update to vX.Y.Z" button.

Uppercase-only match. Whitespace trimmed. The matching string is hardcoded `"UPDATE"`, not the server name (per O7 rationale: typed confirmation defeats accidental clicks; binding to server name adds friction without proportional safety since this is owner+admin gated already).

### 4.7 Backup toggle

Per O3, default ON. Render as a small inline switch above the action button when state is `available` or `up-to-date`:

```
☑ Snapshot state before update
   Restored automatically if the update fails. Adds ~5–30s to update duration.
```

Operator can disable per-server. Disabled value persists in `server.json`. Hidden during in-flight states.

### 4.8 During-update client toast

Independent of the panel — a separate concern, shown to **every connected user** (not just admins) when state transitions to `installing`:

> "Server is updating. You'll be reconnected automatically in ~30 seconds."

Toast persists across the disconnect → reconnect window. Dismissed automatically when WS reconnects on the new version.

### 4.9 Compose-user fallback

For self-hosters running compose without a desktop orchestrator, the runtime can detect "no orchestrator has ever registered" (capability advertisement absent for >24h post-boot). In that case the Runtime panel renders a fourth variant:

- Shows current version, channel, and the available version when present.
- No Update button.
- Instead, a code block with the manual flow:
  ```bash
  docker compose pull
  docker compose up -d
  ```
- Note: "Self-managed installs perform manual updates. Auto-rollback and pre-update backup are not available in this mode — take a snapshot of your volumes before running the commands above."

This satisfies O8's "documented manual flow" requirement.

## 5 · Audit log

Every state transition initiated by user action lands in the existing audit log (`actor=user_id, action=runtime.update.<state>`). Specifically:

- `runtime.update.confirmed` (user typed UPDATE)
- `runtime.update.cancelled` (user cancelled before confirm)
- `runtime.update.channel_changed` (with from/to)
- `runtime.update.backup_toggle_changed` (with from/to)
- `runtime.update.manual_check` (refresh icon click)

Orchestrator-driven transitions (download progress, install lifecycle) do **not** spam the audit log — only user actions do.

## 6 · Copy register

A flat list so this doc is greppable later:

| Key | Copy |
| --- | --- |
| `pill.tooltip.available` | `Update available — vX.Y.Z` |
| `pill.tooltip.pending-confirm` | `Confirm to install vX.Y.Z` |
| `pill.tooltip.backing-up` | `Backing up before update…` |
| `pill.tooltip.downloading` | `Downloading vX.Y.Z — N%` |
| `pill.tooltip.downloaded` | `vX.Y.Z ready to install` |
| `pill.tooltip.installing` | `Installing vX.Y.Z…` |
| `pill.tooltip.rolling-back` | `Update failed — rolling back` |
| `pill.tooltip.error.check` | `Couldn't check for updates. Click for details.` |
| `pill.tooltip.error.backup` | `Backup failed. Click for details.` |
| `pill.tooltip.error.download` | `Download failed. Click for details.` |
| `pill.tooltip.error.rollback` | `Rollback failed — manual recovery required` |
| `panel.helper.up-to-date` | `You're on the latest version.` |
| `panel.helper.available` | `Update available. Click to begin.` |
| `panel.helper.pending-confirm.warning` | `Connected users will be disconnected during install. Auto-rollback engages on health check failure.` |
| `panel.helper.backing-up` | `Snapshotting state directory…` |
| `panel.helper.downloading` | `Pulling vX.Y.Z.` |
| `panel.helper.downloaded` | `vX.Y.Z downloaded. Connected users will be notified before drain.` |
| `panel.helper.installing` | `Draining connections, swapping container, booting new version.` |
| `panel.helper.rolling-back` | `Post-update health check failed. Restoring previous version.` |
| `panel.helper.error.rollback` | `Manual recovery required. See logs and the recovery runbook. Container may be in a partial state.` |
| `panel.offorch.with-permission` | `Updates can only be installed from the orchestrator (currently: {orchestratorName}). Open this server's settings on the orchestrator device to install.` |
| `panel.offorch.no-permission` | `Update available. Ask the server owner or an admin to install.` |
| `panel.confirm.placeholder` | `Type UPDATE to confirm` |
| `panel.confirm.button` | `Confirm` |
| `panel.confirm.cancel` | `Cancel` |
| `panel.backup.label` | `Snapshot state before update` |
| `panel.backup.helper` | `Restored automatically if the update fails. Adds ~5–30s to update duration.` |
| `client.toast.installing` | `Server is updating. You'll be reconnected automatically in ~30 seconds.` |

## 7 · Open questions for Stage 6

These are deferred to implementation, not blockers:

- **Pill vs Wifi/WifiOff coexistence:** decided in §3.1 to replace, but the hybrid-dot-and-icon variant is up to the implementer if it tests better.
- **Highlight-on-deep-link styling:** specific Tailwind ring color/duration is a design call during build.
- **Channel `dev` exposure:** D2 says ship channels in v1 but the `dev` option may be hidden behind a flag for shelf launch. Decide during Stage 6 based on whether dev builds are ready.
- **Manual check rate-limiting:** likely 1 per 30s — concrete value when wiring the refresh icon.
