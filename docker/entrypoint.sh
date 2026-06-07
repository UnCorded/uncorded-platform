#!/bin/bash
# Container entrypoint wrapper — reads a single stdin line containing the
# cloudflare tunnel.json body (if any), writes it atomically to
# /run/tunnel/tunnel.json on tmpfs, then execs the real runtime entrypoint.
#
# The tmpfs mount is provided by the host via `docker run --tmpfs /run/tunnel`.
# The host writes the tunnel token blob over stdin so it never appears in
# `docker inspect` (env) nor on host disk. If stdin is empty or times out
# within 5 seconds (demo-mode containers don't need a token), skip the write
# — the runtime falls back to demo / local mode when credentials_file is
# absent.
#
# bash (not sh/dash) is required for `read -t` timeout support. The base
# image symlinks /bin/sh → dash, whose read builtin rejects -t with
# "Illegal option" and silently skips the write branch.
set -eu

TUNNEL_DIR=/run/tunnel
TUNNEL_FILE="$TUNNEL_DIR/tunnel.json"

if [ -d "$TUNNEL_DIR" ]; then
  # -t 5: if no line arrives within 5s, read returns non-zero and we skip.
  # || true keeps `set -e` from aborting the container on that normal case.
  if IFS= read -r -t 5 LINE 2>/dev/null; then
    if [ -n "${LINE:-}" ]; then
      printf '%s\n' "$LINE" > "$TUNNEL_FILE.tmp"
      chmod 0600 "$TUNNEL_FILE.tmp"
      mv "$TUNNEL_FILE.tmp" "$TUNNEL_FILE"
    fi
  fi
fi

exec bun run /app/runtime/src/entrypoint.ts "$@"
