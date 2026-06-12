# Dev Stack Script — one command, whole stack, per worktree (idea)

**Status: idea, not built.** Captured 2026-06-12 while testing the Plugin Dev
Workspace (which needs desktop + website + a freshly built runtime in
lockstep). Build this when the friction bites again.

## Problem

Testing a cross-tier change today means four terminals (CLAUDE.md dev
workflow) plus `bun run docker:rebuild-runtime` plus an app relaunch — and
when several worktrees are active, multiple Vite servers fight over who is
"the" shell, while the desktop hardcodes `DEV_WEB_URL = localhost:5174`
(`apps/desktop/src/main.ts:177`). Opening the wrong port renders a blank
root with no errors (see memory `shell-dev-server-port-identification`).

## Idea

One script — `bun run dev:stack` from any worktree — that:

1. **Builds the runtime image** from THIS worktree
   (reuse `scripts/rebuild-runtime-image.ts`: build `uncorded-runtime:latest`
   + clear registry containers so the desktop re-runs them fresh).
2. **Starts the website dev server** from this worktree on a deterministic
   per-worktree port (hash of the worktree path → port, printed loudly).
3. **Launches the desktop in dev mode** (reuse
   `apps/desktop/scripts/dev-watch.js`) pointed at that exact port.
   Needs one small desktop change: let an env var (e.g. `UNCORDED_DEV_WEB_URL`)
   override the hardcoded `DEV_WEB_URL` — dev-only, ignored when packaged.
4. Optionally `--central` to also run Central on :4000 (dev containers must
   heartbeat to a local Central — memory `dev-container-central-url-mismatch`).

Everything is sourced from the worktree the script runs in, so "it just
works every time" regardless of which feature branch is being tested.

## Notes / constraints discovered so far

- `rebuild-runtime-image.ts` deliberately does NOT re-run containers (tunnel
  tokens live in Electron safeStorage); the desktop's
  `restoreServerContainers` re-runs them on launch — the script keeps that
  split: build + clear, then launch desktop last.
- Locally built images are unsigned; the runtime tolerates that (no embedded
  cosign pubkey in dev) — fine for dev, never for release.
- Ctrl-C should tear down all children (dev-watch already does this for
  tsc+electron; the stack script wraps the same pattern one level up).
