# Session handoff prompt — Electron 42 upgrade

Copy the block below into a fresh Claude Code session started **in the
`working/worktrees/electron-42-upgrade` worktree** (branch `upgrade/electron-42`).

---

```
We're upgrading the UnCorded desktop app (apps/desktop) from Electron 33.4.11 to
Electron 42. The upgrade has already been scoped — read UPGRADE-PLAN.md in this
worktree root first; it has the full risk analysis, the exact dep set, the
execution steps, and the test matrix. Don't re-derive the scope.

Context you need:
- This is the `upgrade/electron-42` worktree (git worktree off main). Work here,
  commit here. Don't touch main/ or the other worktrees.
- Target: Electron 42 (chosen over 41 for support runway). Latest stable,
  Chromium 148 / Node 24.16.
- The upgrade is low-risk for this codebase specifically — see UPGRADE-PLAN.md
  "Why this is safer than it looks". The native dep is N-API (no ABI rebuild),
  safeStorage format is unchanged (secrets safe), and the one silent-failure
  breaking change (v35 webRequest empty-urls) does NOT apply because main.ts:367
  uses the no-filter form. Verify that's still true before relying on it.

Start with Step 1 from UPGRADE-PLAN.md:
1. Confirm the build host is on Node >=22 (electron-builder 26 needs it).
2. In apps/desktop/package.json bump: electron ^33→^42, electron-builder
   ^25→^26.15.2, electron-updater ^6→^6.8.9, @napi-rs/keyring ^1.2→^1.3.
3. Install (note apps/desktop/.npmrc sets workspaces=false — npm scoped to that
   package; the root is a Bun workspace).
4. Run `bun typecheck` and `bun test` from the worktree root. The ~40 desktop
   tests + apps/desktop/test/preload-electron.ts electron stub will surface any
   type/API drift immediately. Fix drift, get green.
5. Commit (commit-sized, per CLAUDE.md). End commit messages with the
   Co-Authored-By line.

Do NOT do step 2 (electron-builder packaging) or the manual cross-platform smoke
tests yet — flag when step 1 is green and we'll decide next move. The gating
release tests (safeStorage round-trip on real Windows+Linux profiles, AppImage
GTK4/Wayland rendering, Windows icon rcedit, packaged keyring load) need real
machines and can't run in CI — see UPGRADE-PLAN.md "What CI catches vs what
needs hands".

Honor the repo's CLAUDE.md: nothing moves forward until bun test + bun typecheck
pass clean; no `any`; every fix gets a regression test.
```

---

## Quick orientation (for the human, not the prompt)

- **Worktree:** `working/worktrees/electron-42-upgrade` · **branch:** `upgrade/electron-42` (off `main` @ 3a9fbc7)
- **Plan:** `UPGRADE-PLAN.md` (this dir)
- **First command after `cd` into the worktree:** read `UPGRADE-PLAN.md`, then bump the 4 deps in `apps/desktop/package.json`.
- **Gate before any release:** the 6-item test matrix in the plan; items 2/5/6/3 need real Windows + Linux machines.
