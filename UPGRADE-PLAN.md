# Electron 33 → 42 Upgrade Plan

**Branch:** `upgrade/electron-42` · **Worktree:** `working/worktrees/electron-42-upgrade`
**Scoped:** 2026-06-10 · **Target:** Electron 42 (latest stable, Chromium 148 / Node 24.16, supported to ~Nov 2026)
**Current:** Electron 33.4.11 (8 majors behind; v33 is EOL)

---

## Bottom line

Low-risk upgrade *for this codebase*, despite the 8-major gap. Three structural facts collapse most
breaking changes to non-issues (all verified against the actual code, not just the changelog):

- **Only native dep is `@napi-rs/keyring` (pure N-API)** → N-API is ABI-stable across Node majors, so
  the Node 20→22→24 jump does **not** force a recompile or orphan it. The usual #1 upgrade pain doesn't apply.
- **`safeStorage` format unchanged across v34–v42** → encrypted tunnel tokens + runtime encryption
  secrets stay decryptable. (Highest risk, cleared. "safeStorage" appears in no breaking-changes doc in range.)
- **macOS isn't built yet** (commented out in `electron-builder.yml`) → every macOS breaking change in
  range is moot for the shipping targets (Windows NSIS + Linux AppImage).
- **Windows builds are unsigned by design (Phase 1)** → electron-builder 26's `win.signtoolOptions`
  migration doesn't bite yet.
- **Renderer is a remote web app that never imports `electron`** (confirmed: no `electron`/`clipboard`/
  `webFrame` imports in `apps/website/src`) → all renderer-side deprecations (v40 `clipboard`, etc.) irrelevant.

### The one scary breaking change — dodged

v35 changed `webRequest` filters so an empty `urls: []` no longer matches all URLs. The CSP-rewrite in
`installShellCSP()` (`apps/desktop/src/main.ts:367`) is exactly the kind of code that would break
*silently* (CSP just stops being enforced — a security regression with no error). **Verified:** the call
uses the **no-filter form** `webRequest.onHeadersReceived((details, callback) => …)`, which retains
match-all. The breaking change only hits the explicit `{ urls: [] }` form. We're on the safe side — but it
stays a **must-test** item precisely because it fails quietly.

---

## Version reference

| Electron | Chromium | Node | Notes |
|----------|----------|------|-------|
| 33 (current) | 130 | 20.18 | EOL |
| 35 | 134 | 22.14 | **Node 20→22 jump**; webRequest empty-`urls` change (we dodge) |
| 36 | 136 | 22.14 | Linux GTK4 default on GNOME; commandLine lowercases switches |
| 38 | 140 | 22.18 | Linux Wayland default |
| 40 | 144 | 24.x | **Node 22→24 jump** |
| **42 (target)** | 148 | 24.16 | latest stable, supported ~Nov 2026 |

---

## Required changes (the whole code/config change set)

`apps/desktop/package.json`:

| Package | From | To |
|---------|------|-----|
| `electron` | `^33.0.0` | `^42.0.0` |
| `electron-builder` | `^25.0.0` | `^26.15.2` |
| `electron-updater` | `^6.0.0` | `^6.8.9` |
| `@napi-rs/keyring` | `^1.2.0` | `^1.3.0` |

Plus:
- **Build host needs Node ≥ 22** (electron-builder 26 / `@electron/rebuild` v4) — local toolchain + CI runner.
- **Confirm `asarUnpack` for the keyring `.node`** so the prebuilt binary loads from the packaged asar.

No source rewrites are forced by the API surface. Confirmed unchanged for our usage:
`setPermissionRequestHandler`/`setPermissionCheckHandler` (signature change was v13, predates us),
`<webview>`/`will-attach-webview`, `setDisplayMediaRequestHandler`, `clearStorageData({storages:['serviceworkers']})`,
`desktopCapturer.getSources`, `Tray`, dialogs, IPC bridge, `nativeImage`, `shell.openExternal`,
`systemPreferences.getMediaAccessStatus`, all `app.*` methods/events, `BrowserWindow` webPreferences/titleBarStyle.

---

## Execution steps (commit-sized)

1. **Deps + build-host Node.** Bump the four packages; ensure Node ≥22. Run `bun typecheck` + `bun test`
   green. The ~40 desktop tests + the `apps/desktop/test/preload-electron.ts` electron stub catch type
   drift immediately. → commit.
2. **Build.** `bun run build` (electron-builder 26). Confirm NSIS (Windows) + AppImage (Linux) artifacts
   produce, the `.node` unpacks, and `latest.yml` emits in the expected format. → commit.
3. **Manual cross-platform smoke** (see risks below). Can't be done by `bun test`.
4. **Ship.** Bump app `version` in `apps/desktop/package.json`, release to the `UnCorded/releases` feed.

---

## Residual risks — test matrix (priority order)

1. **CSP still rewrites** — assert a shell top-level response carries the rewritten
   `Content-Security-Policy` header post-upgrade. Guards the silent v35 regression. *(automatable)*
2. **safeStorage round-trips EXISTING secrets** — encrypt a token under the v33 build, decrypt under the
   v42 build on the **same Windows + Linux profile**. Proves tunnel tokens / runtime secrets aren't orphaned.
   *(needs real machines)*
3. **Keyring loads under Electron 42 / Node 24** in the **packaged** app — no `NODE_MODULE_VERSION` error;
   `.node` is unpacked. *(needs packaged build)*
4. **electron-updater e2e** against an electron-builder-26-generated `latest.yml` — check → download →
   quitAndInstall; GitHub provider; `autoDownload=false`. Contract is unchanged but verify end-to-end.
5. **Linux AppImage rendering** — v36 defaulted GTK4 (GNOME), v38 defaulted Wayland. Real chance of
   theming/rendering surprises. Fallbacks: `--gtk-version=3` / `--ozone-platform=x11`. *(needs real Linux)*
6. **rcedit still embeds `icon.ico` + version metadata** in `UnCorded.exe` under builder 26 — there's a
   documented past scar here (v0.0.2 shipped Electron's default atom icon). Confirm the unsigned NSIS exe
   gets the UnCorded icon. *(needs packaged Windows build)*

Lower-risk, glance only: v41 renders PDFs in the same WebContents instead of a child guest. The
`getAllWebContents()` / `getType()==="webview"` sweeps (`main.ts:501`, `652`) filter to webview type, so
this is benign — but it touches that code path.

---

## What CI catches vs. what needs hands

- **`bun test` / `bun typecheck`** catch: type drift, IPC contract drift (via `preload-electron.ts`),
  reducer/orchestration logic. → steps 1.
- **Needs real machines** (CI can't): #2 safeStorage round-trip, #5 Linux AppImage rendering, #6 Windows
  icon embedding, #3 packaged keyring load. These are the gating items before release.

---

## Key files

- `apps/desktop/package.json` — dep bumps + app version
- `apps/desktop/electron-builder.yml` — NSIS/AppImage targets, unsigned-by-design comments, rcedit note,
  `extraResources` cosign, GitHub `UnCorded/releases` publish
- `apps/desktop/src/main.ts` — full Electron main surface; CSP rewrite at `:367`, webContents sweeps at `:501`/`:652`
- `apps/desktop/src/secret-store.ts` — safeStorage + `@napi-rs/keyring` usage
- `apps/desktop/src/auto-update.ts` — electron-updater state machine
- `apps/desktop/test/preload-electron.ts` — the electron stub all desktop tests link against
