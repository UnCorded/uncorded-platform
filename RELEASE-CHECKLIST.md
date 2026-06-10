# Electron 42 — release & updater-validation checklist

Goal: prove the Electron 42 build ships and auto-updates on real machines,
without a Linux desktop. CI is the Linux machine; your installed Windows app
is the updater test rig.

**State going in:** branch `upgrade/electron-42`, desktop version **0.0.30**
(bumped from 0.0.29). You currently have the locally-built **0.0.29** Electron-42
installer installed and running. Publishing 0.0.30 is what the installed 0.0.29
will update *to*.

---

## Step A — push the branch, let CI validate (Linux, no machine needed)

```bash
git push -u origin upgrade/electron-42
```

`ci.yml` runs on the push/PR: typecheck + lint + the desktop/runtime/website/
plugin test suites on **ubuntu-latest**, plus the Central suite against a
throwaway Postgres. Green here = the upgrade passes every merge gate on Linux.

✅ Pass condition: all `ci` jobs green.

> Note: `ci.yml` does NOT build the desktop installer — it builds nothing for
> distribution. The Linux *build* is proven in Step B.

---

## Step B — dispatch the release build (builds BOTH platforms)

`release.yml` is `workflow_dispatch` only. Trigger it on the `upgrade/electron-42`
ref (GitHub UI → Actions → "release" → Run workflow → pick the branch, or):

```bash
gh workflow run release.yml --ref upgrade/electron-42
```

The matrix builds on `ubuntu-latest` + `windows-latest` and uploads to a
**draft** release on `UnCorded/releases` (needs the `RELEASES_PAT` secret).

✅ Pass conditions:
- **Both** matrix legs green — this is the proof the **Linux AppImage builds**
  under Electron 42 / Node 24 (the thing you can't do locally).
- Draft release contains: `UnCorded-Setup-0.0.30.exe` + `latest.yml` (Windows)
  and `UnCorded-*-0.0.30.AppImage` + `latest-linux.yml` (Linux), each with a
  `.blockmap`.

Nothing is live yet — a draft is invisible to electron-updater clients.

---

## Step C — publish, and watch the installed app self-update (Windows e2e)

1. On `UnCorded/releases`, edit the draft → **Publish release**. (GitHub creates
   the `v0.0.30` tag at publish time — it does NOT re-trigger `release.yml`,
   which is dispatch-only by design.)
2. Launch your installed **0.0.29** app (or leave it running). Within ~15s of
   startup it checks the feed; 0.0.30 > 0.0.29 fires `update-available`.
3. The app is configured `autoDownload=false`, so the **download** and
   **install** are user-gated through the in-app update UI — trigger them and
   confirm: download progresses → `update-downloaded` → quit-and-install relaunches
   on **0.0.30**.

✅ Pass condition: app relaunches reporting version **0.0.30**. That exercises
the entire updater pipeline (feed fetch → sha512 integrity → NSIS swap →
relaunch) for real. Because Windows and Linux share the same updater code and
config — only the feed file differs (`latest.yml` vs `latest-linux.yml`, both
electron-builder-generated) — a green Windows e2e gives high confidence the
Linux updater works too.

> Unsigned-Windows note: electron-updater skips signature verification when the
> build has no `publisherName` and relies on the `latest.yml` sha512/blockmap
> for integrity — so auto-update works on the Phase-1 unsigned build.

---

## Step D — the one thing that still wants Linux eyes (low risk)

Only the **visual rendering** of the AppImage (GTK4 default since v36, Wayland
since v38) can't be checked without a Linux GUI. If a homelab tester reports a
blank/garbled window, the fallbacks are launch flags: `--gtk-version=3` or
`--ozone-platform=x11`. The build itself is already proven by Step B.

---

## Step E — merge

Once A–C are green:

```bash
# open a PR upgrade/electron-42 -> main, or fast-forward if you prefer
gh pr create --base main --head upgrade/electron-42 --fill
```

After merge, remove the worktree:

```bash
git worktree remove working/worktrees/electron-42-upgrade
git branch -d upgrade/electron-42   # after the PR merges
```

---

## Quick status board

| Gate | How | State |
|------|-----|-------|
| Deps bumped + typecheck + tests | local | ✅ done |
| Windows packaging (installer, keyring unpack, icon) | local build | ✅ done |
| Windows smoke + safeStorage round-trip | manual (you) | ✅ done |
| Linux tests/typecheck | `ci.yml` | ⬜ Step A |
| Linux AppImage **build** | `release.yml` matrix | ⬜ Step B |
| Updater e2e (download→install→relaunch) | publish 0.0.30, Windows | ⬜ Step C |
| Linux AppImage **rendering** | tester eyes | ⬜ Step D (low risk) |
| Merge to main | PR | ⬜ Step E |
