# Download cloudflared in a separate stage so we don't need build tools in the final image.
# Alpine has wget. TARGETARCH is set by Docker buildx (amd64 / arm64).
#
# cloudflared is pinned to a specific release rather than `latest` so a Cloudflare
# publish never silently changes the binary shipped inside our image. Bump
# CLOUDFLARED_VERSION when a security or functionality fix is needed, and verify
# the binary against its published checksum in release notes before updating.
FROM alpine AS cloudflared-dl
ARG TARGETARCH=amd64
ARG CLOUDFLARED_VERSION=2025.2.0
RUN wget -qO /cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH}" \
    && chmod +x /cloudflared

# Download tini statically in a separate stage — same pattern as cloudflared.
# tini serves as PID 1 for signal forwarding and zombie reaping. Pin to a
# specific release and bump TINI_VERSION when a security fix is needed.
FROM alpine AS tini-dl
ARG TARGETARCH=amd64
ARG TINI_VERSION=v0.19.0
RUN wget -qO /tini \
      "https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini-static-${TARGETARCH}" \
    && chmod +x /tini

# Download LiveKit SFU in a separate stage. Pinned to a specific release with
# SHA256 verification — no curl-pipe-tar without integrity checks. The
# checksums are required build-args (no defaults) so a missing/wrong arg
# fails the build instead of silently baking an unverified binary.
#
# To find current checksums:
#   curl -L "https://github.com/livekit/livekit/releases/download/${LIVEKIT_VERSION}/checksums.txt"
#
# Build invocation:
#   docker build \
#     --build-arg LIVEKIT_SHA256_AMD64=<sha256 of livekit_*_linux_amd64.tar.gz> \
#     --build-arg LIVEKIT_SHA256_ARM64=<sha256 of livekit_*_linux_arm64.tar.gz> \
#     ...
FROM alpine AS livekit-dl
ARG TARGETARCH=amd64
ARG LIVEKIT_VERSION=v1.11.0
ARG LIVEKIT_SHA256_AMD64
ARG LIVEKIT_SHA256_ARM64
RUN apk add --no-cache wget tar coreutils \
    && case "${TARGETARCH}" in \
         amd64) EXPECTED_SHA="${LIVEKIT_SHA256_AMD64}" ;; \
         arm64) EXPECTED_SHA="${LIVEKIT_SHA256_ARM64}" ;; \
         *) echo "Unsupported TARGETARCH=${TARGETARCH}" >&2 ; exit 1 ;; \
       esac \
    && if [ -z "${EXPECTED_SHA}" ]; then \
         echo "LIVEKIT_SHA256 build-arg for arch ${TARGETARCH} is required — refusing to build with unverified binary" >&2 ; \
         exit 1 ; \
       fi \
    && VERSION_NUM="${LIVEKIT_VERSION#v}" \
    && ARCHIVE="livekit_${VERSION_NUM}_linux_${TARGETARCH}.tar.gz" \
    && wget -qO "/tmp/${ARCHIVE}" \
         "https://github.com/livekit/livekit/releases/download/${LIVEKIT_VERSION}/${ARCHIVE}" \
    && echo "${EXPECTED_SHA}  /tmp/${ARCHIVE}" | sha256sum -c - \
    && mkdir -p /tmp/livekit \
    && tar -xzf "/tmp/${ARCHIVE}" -C /tmp/livekit \
    && find /tmp/livekit -type f -name 'livekit-server' -exec mv {} /livekit-server \; \
    && chmod +x /livekit-server \
    && /livekit-server --version

# Download the Codex CLI — the agent harness t3-code drives (`codex exec` /
# `codex login`). The musl target is a statically linked Rust binary, so it
# runs on the debian base with no libc deps. Pinned; bump CODEX_VERSION to
# update (verify against the release before bumping). gh is NOT required —
# same wget-from-releases pattern as cloudflared/livekit.
FROM alpine AS codex-dl
ARG TARGETARCH=amd64
ARG CODEX_VERSION=rust-v0.139.0
RUN apk add --no-cache wget tar \
    && case "${TARGETARCH}" in \
         amd64) TRIPLE="x86_64-unknown-linux-musl" ;; \
         arm64) TRIPLE="aarch64-unknown-linux-musl" ;; \
         *) echo "Unsupported TARGETARCH=${TARGETARCH}" >&2 ; exit 1 ;; \
       esac \
    && wget -qO /tmp/codex.tar.gz \
         "https://github.com/openai/codex/releases/download/${CODEX_VERSION}/codex-${TRIPLE}.tar.gz" \
    && mkdir -p /tmp/codex \
    && tar -xzf /tmp/codex.tar.gz -C /tmp/codex \
    && find /tmp/codex -type f -name 'codex*' -exec mv {} /codex \; \
    && chmod +x /codex \
    && /codex --version

# Download the GitHub CLI — t3 drives GitHub auth + PRs through `gh`
# (`gh auth`, `gh pr`), not a token/credential-helper. Per-user `gh auth login`
# lands in each user's HOME = the per-user workspace the instance is spawned
# with. CGO_ENABLED=0 Go binary → static, runs on alpine (this stage) + debian.
FROM alpine AS gh-dl
ARG TARGETARCH=amd64
ARG GH_VERSION=2.94.0
RUN apk add --no-cache wget tar \
    && case "${TARGETARCH}" in \
         amd64) GHARCH="amd64" ;; \
         arm64) GHARCH="arm64" ;; \
         *) echo "Unsupported TARGETARCH=${TARGETARCH}" >&2 ; exit 1 ;; \
       esac \
    && wget -qO /tmp/gh.tar.gz \
         "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GHARCH}.tar.gz" \
    && mkdir -p /tmp/gh \
    && tar -xzf /tmp/gh.tar.gz -C /tmp/gh \
    && find /tmp/gh -type f -name gh -path '*/bin/*' -exec mv {} /gh \; \
    && chmod +x /gh \
    && /gh --version

FROM oven/bun:1.3 AS base

WORKDIR /app

# debian-slim (the base of oven/bun:1.3) ships with no system trust store, so
# any Go-built binary that uses crypto/tls — notably cloudflared, which signs
# TLS to api.trycloudflare.com when registering a quick tunnel — fails with
# `x509: certificate signed by unknown authority`. Bun's installer works
# without this because Bun statically links its own roots. Keep this layer
# near the top of the base stage so it stays cache-hot across source edits.
#
# git is required by repo-oriented plugins inside the runtime — t3-code clones
# project repos and t3 itself drives branch/commit/PR flows; without git on
# PATH those features fail at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first (cache-friendly layer)
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/protocol-schemas/package.json packages/protocol-schemas/package.json
COPY packages/plugin-sdk/package.json packages/plugin-sdk/package.json
COPY packages/plugin-sdk-frontend/package.json packages/plugin-sdk-frontend/package.json
COPY packages/electron-bridge/package.json packages/electron-bridge/package.json
# Workspace manifests must all be present for bun install --frozen-lockfile to reconcile
COPY apps/central/package.json apps/central/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/website/package.json apps/website/package.json
RUN bun install --frozen-lockfile

# Copy source code
COPY tsconfig.json ./
COPY packages/ packages/
COPY runtime/src/ runtime/src/
COPY runtime/admin/ runtime/admin/
COPY plugins/text-channels/ core-plugins/text-channels/
COPY plugins/voice-channels/ core-plugins/voice-channels/
# plugins/members and plugins/moderation are Phase 2 — add COPY lines when implemented

# Build the frontend SDK bundle (served at /sdk/plugin-frontend.js).
# Done at image build time — not startup — so a broken build fails the image build,
# not a silent runtime error at first request.
RUN bun build packages/plugin-sdk-frontend/src/global.ts \
    --outfile runtime/public/sdk/plugin-frontend.js \
    --format iife --minify

# Bake the bundle's content hash into every plugin iframe HTML's <script src>
# reference (e.g. ?v=ab12cd34ef56). The URL changes whenever the bundle
# changes, so browser HTTP caches and CDN edge caches automatically fetch
# fresh — no manual cache busting needed after each rebuild.
COPY scripts/stamp-sdk-cache-bust.ts /tmp/stamp-sdk-cache-bust.ts
RUN bun run /tmp/stamp-sdk-cache-bust.ts && rm /tmp/stamp-sdk-cache-bust.ts

# Install cloudflared binary (quick tunnel + authenticated tunnel support).
# Runs as UID 1001 — no caps needed for cloudflared tunnel mode.
COPY --from=cloudflared-dl /cloudflared /usr/local/bin/cloudflared

# Codex CLI on PATH for repo-oriented plugins (t3-code drives `codex exec`).
# Per-user auth (`codex login`) lands in each user's HOME = the per-user
# workspace the t3 instance is spawned with.
COPY --from=codex-dl /codex /usr/local/bin/codex

# GitHub CLI on PATH — t3's GitHub provider (auth, private clone, push, PRs).
COPY --from=gh-dl /gh /usr/local/bin/gh

# tini as PID 1 for signal forwarding + zombie reaping. Downloaded as a
# static binary so the image is self-contained and distro-independent.
COPY --from=tini-dl /tini /sbin/tini

# Bundled LiveKit SFU. Owned by root, executable for everyone — the
# runtime spawns it as UID 1001. No write access for non-root, so the
# binary can't be replaced from inside a compromised plugin subprocess.
COPY --from=livekit-dl /livekit-server /opt/livekit/livekit-server
ENV LIVEKIT_BIN_PATH=/opt/livekit/livekit-server

# Create volume mount points owned by the runtime UID (1001).
# /run/tunnel is the tmpfs mount target for the cloudflare tunnel token —
# the host injects the token via stdin at container start (see entrypoint.sh).
# /config/voice holds the runtime-rendered livekit.yaml at mode 0600 — the
# config directory itself must be writable by the runtime UID since the
# supervisor (re)writes the file on credential rotation.
# Using a numeric UID avoids depending on adduser/useradd presence in the base image.
RUN mkdir -p /plugins /data /config /config/voice /run/tunnel \
    && chown -R 1001:1001 /plugins /data /config /run/tunnel

# Stdin-reading wrapper that lays down /run/tunnel/tunnel.json from the
# host-supplied tunnel token, then execs the real runtime entrypoint.
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# RUNTIME_VERSION is baked at build time. Defaults to "0.0.0-dev" for local
# rebuilds; the release workflow passes the release tag (e.g. "0.1.0"). The
# entrypoint reads process.env.RUNTIME_VERSION at boot and surfaces it in
# /health, heartbeat to Central, and the update-state broadcast. Without
# this build-arg, the runtime would report a hardcoded version forever.
ARG RUNTIME_VERSION=0.0.0-dev
ENV RUNTIME_VERSION=${RUNTIME_VERSION}

EXPOSE 3000

# HEALTHCHECK against /health — pure liveness, returns 200 whenever the
# process can respond. We deliberately do NOT probe /ready here: /ready
# fails closed when Central's public-key cache goes stale, and Docker
# restarting the container in that case is counterproductive (the new
# container can't reach Central either, and restart-thrash would shorten
# our key-cache window on every loop). Cloudflare Tunnel and other
# traffic-routers should poll /ready instead — that's where readiness
# signals live. --start-period covers first-boot migrations + plugin
# handshake; intervals after that are cheap.
#
# Uses bun (already in the image) — oven/bun:1.3 is debian-slim and ships
# without wget/curl, so an external probe binary would have to be installed
# just for this. bun -e is ~100ms cold and well under the 5s timeout.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

USER 1001

ENTRYPOINT ["/sbin/tini", "--", "/app/entrypoint.sh"]
