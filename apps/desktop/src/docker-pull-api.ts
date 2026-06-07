// Streams pull progress from the Docker daemon's HTTP API instead of
// shelling out to `docker pull`. The CLI auto-detects whether stdout is a
// TTY and falls back to *summary* mode when it isn't (which is what Node's
// `child_process.spawn` gives it) — no `\r`-redrawn progress bar, no
// percentage lines, just `Pulling fs layer` / `Pull complete` events. The
// orchestrator's `extractPullPercent` then matches nothing and the runtime-
// update UI was wedged at "0%" for the entire pull. Hitting the daemon API
// gives us structured `progressDetail.current/total` JSON events for every
// layer regardless of TTY state.
//
// We keep the same callback shape as `docker.pullImage` (per-line strings)
// and re-emit the daemon events as fake "Downloading X B/Y B" lines so the
// orchestrator's existing line-parser at runtime-update.ts:236 picks them
// up unchanged. That keeps blast radius limited to this file plus a single
// delegation in docker.ts.
//
// Cross-platform socket paths:
//   - Linux:                 /var/run/docker.sock
//   - macOS Docker Desktop:  same (CLI symlinks ~/.docker/run/docker.sock)
//   - Windows Docker Desktop: \\.\pipe\docker_engine (named pipe)
// Node's http.request honours `socketPath` for both Unix sockets and
// Windows named pipes (net.Socket dispatches to the right transport),
// so a single code path handles all three.

import { request } from "node:http";
import { platform } from "node:os";

interface DockerPullEvent {
  status?: string;
  id?: string;
  progress?: string;
  progressDetail?: { current?: number; total?: number };
  error?: string;
  errorDetail?: { message?: string };
}

/** Resolves the Docker daemon socket. Honours $DOCKER_HOST_OVERRIDE_SOCKET
 *  for tests + advanced users; otherwise picks the OS default. */
export function getDockerSocketPath(): string {
  const override = process.env.DOCKER_HOST_OVERRIDE_SOCKET;
  if (override !== undefined && override.length > 0) return override;
  if (platform() === "win32") return "\\\\.\\pipe\\docker_engine";
  return "/var/run/docker.sock";
}

/** Splits a pull reference like `ghcr.io/uncorded/runtime:0.1.0-dev.16`
 *  into [`ghcr.io/uncorded/runtime`, `0.1.0-dev.16`]. A colon BEFORE the
 *  last slash belongs to a registry port (e.g. `localhost:5000/foo`), not
 *  a tag separator. Defaults to `latest` when no tag is present. */
export function parseImageRef(image: string): { name: string; tag: string } {
  const lastColon = image.lastIndexOf(":");
  const lastSlash = image.lastIndexOf("/");
  if (lastColon === -1 || lastColon < lastSlash) {
    return { name: image, tag: "latest" };
  }
  return { name: image.slice(0, lastColon), tag: image.slice(lastColon + 1) };
}

/** Re-emits a daemon JSON event as a single line consumable by the
 *  orchestrator's existing line-based parser. When `progressDetail` carries
 *  byte counts, formats them as `<id>: <status> <current>B/<total>B` so the
 *  `extractPullPercent` regex picks the percentage out without changes. */
export function formatPullEventLine(event: DockerPullEvent): string | null {
  const status = event.status;
  if (typeof status !== "string" || status.length === 0) return null;
  const idPrefix = typeof event.id === "string" && event.id.length > 0
    ? `${event.id}: `
    : "";
  const detail = event.progressDetail;
  if (detail && typeof detail.total === "number" && detail.total > 0
    && typeof detail.current === "number" && detail.current >= 0) {
    return `${idPrefix}${status} ${String(detail.current)}B/${String(detail.total)}B`;
  }
  return `${idPrefix}${status}`;
}

export function pullImageViaApi(
  image: string,
  onProgress: (line: string) => void,
  onDone: () => void,
  onError: (msg: string) => void,
): void {
  const { name, tag } = parseImageRef(image);
  const path = `/v1.41/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`;
  let finished = false;
  function complete(kind: "done" | "error", message?: string): void {
    if (finished) return;
    finished = true;
    if (kind === "done") {
      onDone();
    } else {
      onError(message ?? `docker pull failed for ${image}`);
    }
  }

  const req = request(
    {
      socketPath: getDockerSocketPath(),
      method: "POST",
      path,
      headers: {
        "Content-Type": "application/json",
        "X-Registry-Auth": "",
      },
    },
    (res) => {
      const status = res.statusCode ?? 0;
      if (status !== 200) {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => {
          complete("error", `docker daemon returned ${String(status)}: ${body.trim() || "no body"}`);
        });
        res.on("error", (err) => complete("error", err.message));
        return;
      }
      let buffer = "";
      let pullErr: string | null = null;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const raw = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
          if (raw.length === 0) continue;
          let event: DockerPullEvent;
          try {
            event = JSON.parse(raw) as DockerPullEvent;
          } catch {
            continue;
          }
          if (typeof event.error === "string" && event.error.length > 0) {
            pullErr = event.errorDetail?.message ?? event.error;
            continue;
          }
          const line = formatPullEventLine(event);
          if (line !== null) onProgress(line);
        }
      });
      res.on("end", () => {
        if (pullErr !== null) {
          complete("error", pullErr);
        } else {
          complete("done");
        }
      });
      res.on("error", (err) => complete("error", err.message));
    },
  );
  req.on("error", (err) => complete("error", err.message));
  req.end();
}
