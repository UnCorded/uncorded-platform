# Phase 01 — Bare Runtime, Shelf-Ready

> **Status:** Scoping in progress · Started 2026-05-07 · Not yet underway in code.

## Goal

A production-grade runtime that boots cleanly with **zero plugins**, supports a polished owner-driven update flow from inside the shell, and survives version updates without data loss. The end of Phase 01 is the foundation Phase 02+ assumes.

## Success criteria

- A self-hoster installs the runtime in a single command and boots it with zero plugins.
- An empty server presents a meaningful first-run state in the shell — not a blank screen, not an error.
- An owner can update the runtime from **Server Settings → Danger Zone**, with: pre-flight checks, owner-only gate (re-auth or typed confirmation), graceful WS drain, automatic rollback on failure, audit entry on success.
- Updates are signed; runtime verifies signature before swap.
- A full E2E cycle — install v0.x.0 → run → publish v0.x.1 → owner triggers update → run on new version — passes with no manual intervention and no errors.
- State directory exists, is preserved across updates, and is documented as the contract Phase 02 plugins will write into.

## Out of scope (Phase 01)

- Plugin lifecycle, install, hot-add (Phase 02)
- Central marketplace UI polish (later phase)
- Mobile client
- Cross-runtime federation

## Folder index

| File | Purpose | Status |
| --- | --- | --- |
| `README.md` | This file. Orientation, scope, success criteria. | ✅ |
| `plan.md` | Work breakdown, stages, ordering. | ✅ |
| `decisions.md` | Resolved + open decisions with rationale. | ✅ |
| `current-state.md` | Code inventory: what exists today (file:line) vs what changes. | ✅ partial (build + update) · full inventory deferred to per-stage reads |
| `runtime-lifecycle.md` | Boot / shutdown / update / rollback technical spec. | ✅ |
| `update-ux.md` | Danger Zone settings UX spec — screens, copy, gates, state machine. | ✅ |

## How a fresh session should use this folder

1. Read `README.md` (this file) → understand goal and success criteria.
2. Read `decisions.md` → understand what's locked and what's still open.
3. Read `plan.md` → understand where we are in the work.
4. Read whichever stage-specific file matches current work.

This folder is intended to be **self-contained** for orientation. Older vault docs (`Overview/spec-*.md`) remain authoritative for what they describe, but for Phase 01 work, the prod-docs folder is the source of truth.
