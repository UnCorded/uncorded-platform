# Running the Central test suite

Central's tests talk to a real PostgreSQL. This doc is the fast path to a green
run locally and in CI.

## TL;DR

```bash
bun run test:central:db        # start a throwaway Postgres (waits until healthy)
bun run test:central           # run the full Central suite against it
bun run test:central:db:stop   # tear it down (data is discarded)
```

`test:central:db` needs Docker running. The Postgres it starts is RAM-backed
(tmpfs) and wiped on stop, so every run begins from a clean slate.

## What needs a database

Most files under `apps/central/src` spin up an in-process server via
`startTestServer()` / `setupTestDb()` (see `src/test-helpers.ts`), which
creates and drops its own `uncorded_central_test` database. These tests need a
reachable Postgres — without one they **fail**, they do not skip.

Two suites are deliberately gated behind `DATABASE_URL` and skip cleanly when it
is unset (`integration.test.ts`, `crypto-rotation.test.ts`) because they are the
heavy full-lifecycle runs. `bun run test:central` sets `DATABASE_URL`, so they
run as part of the suite.

The pure-unit files (`crypto.test.ts`, `usernames.test.ts`,
`plugin-package.test.ts`, …) need no database and run anywhere.

## The connection contract

Both the app (`src/index.ts`) and the tests (`src/test-helpers.ts`) read these
env vars, with the defaults the throwaway Postgres above is configured to match:

| Var           | Default     |
| ------------- | ----------- |
| `DB_HOST`     | `localhost` |
| `DB_PORT`     | `5432`      |
| `DB_USER`     | `postgres`  |
| `DB_PASSWORD` | `postgres`  |

> **Gotcha:** `DATABASE_URL` is only a *gate flag* — its presence enables the
> gated suites. It is **not parsed** for connection details. If your Postgres
> is not on `localhost:5432` with `postgres`/`postgres`, set the `DB_*` vars
> above; changing `DATABASE_URL` alone will not repoint the connection.

## CI

```bash
bun run test:central:db
bun run test:central
bun run test:central:db:stop   # run even on failure (CI `always()` / `finally`)
```

If your CI provides its own Postgres (e.g. a service container), skip
`test:central:db` and instead export the `DB_*` vars plus a non-empty
`DATABASE_URL`, then run `bun run test:central`.

## Boot test

`index.boot.test.ts` is excluded from the default run (see `bunfig.toml`) and has
its own command: `bun run test:boot`.
