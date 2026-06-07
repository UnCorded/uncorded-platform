import { describe, expect, it } from "bun:test";
import { formatPullEventLine, getDockerSocketPath, parseImageRef } from "./docker-pull-api";

describe("parseImageRef", () => {
  it("splits a normal name:tag pair", () => {
    expect(parseImageRef("uncorded/runtime:0.1.0-dev.16")).toEqual({
      name: "uncorded/runtime",
      tag: "0.1.0-dev.16",
    });
  });

  it("handles a fully-qualified registry reference", () => {
    expect(parseImageRef("ghcr.io/uncorded/runtime:0.1.0-dev.16")).toEqual({
      name: "ghcr.io/uncorded/runtime",
      tag: "0.1.0-dev.16",
    });
  });

  it("defaults to `latest` when no tag is present", () => {
    expect(parseImageRef("uncorded/runtime")).toEqual({
      name: "uncorded/runtime",
      tag: "latest",
    });
  });

  it("does not mistake a registry port for a tag separator", () => {
    expect(parseImageRef("localhost:5000/foo")).toEqual({
      name: "localhost:5000/foo",
      tag: "latest",
    });
  });

  it("keeps registry port and tag separate when both present", () => {
    expect(parseImageRef("localhost:5000/foo:dev")).toEqual({
      name: "localhost:5000/foo",
      tag: "dev",
    });
  });
});

describe("formatPullEventLine", () => {
  it("returns a `<id>: <status> <current>B/<total>B` line for a layer with progress bytes", () => {
    const line = formatPullEventLine({
      status: "Downloading",
      id: "abc123",
      progressDetail: { current: 1024, total: 4096 },
    });
    expect(line).toBe("abc123: Downloading 1024B/4096B");
  });

  it("falls back to the bare status line when progressDetail is absent", () => {
    expect(
      formatPullEventLine({ status: "Pulling fs layer", id: "abc123" }),
    ).toBe("abc123: Pulling fs layer");
  });

  it("omits the id prefix when no id is present", () => {
    expect(formatPullEventLine({ status: "Pulling from uncorded/runtime" }))
      .toBe("Pulling from uncorded/runtime");
  });

  it("returns null when there is no status to render", () => {
    expect(formatPullEventLine({})).toBeNull();
    expect(formatPullEventLine({ status: "" })).toBeNull();
  });

  it("ignores progressDetail when total is zero (avoids 0/0 noise)", () => {
    const line = formatPullEventLine({
      status: "Waiting",
      id: "abc123",
      progressDetail: { current: 0, total: 0 },
    });
    expect(line).toBe("abc123: Waiting");
  });
});

describe("getDockerSocketPath", () => {
  it("honours DOCKER_HOST_OVERRIDE_SOCKET when set", () => {
    const original = process.env.DOCKER_HOST_OVERRIDE_SOCKET;
    process.env.DOCKER_HOST_OVERRIDE_SOCKET = "/tmp/fake.sock";
    try {
      expect(getDockerSocketPath()).toBe("/tmp/fake.sock");
    } finally {
      if (original === undefined) delete process.env.DOCKER_HOST_OVERRIDE_SOCKET;
      else process.env.DOCKER_HOST_OVERRIDE_SOCKET = original;
    }
  });

  it("returns an OS-appropriate default when no override is set", () => {
    const original = process.env.DOCKER_HOST_OVERRIDE_SOCKET;
    delete process.env.DOCKER_HOST_OVERRIDE_SOCKET;
    try {
      const path = getDockerSocketPath();
      if (process.platform === "win32") {
        expect(path).toBe("\\\\.\\pipe\\docker_engine");
      } else {
        expect(path).toBe("/var/run/docker.sock");
      }
    } finally {
      if (original !== undefined) process.env.DOCKER_HOST_OVERRIDE_SOCKET = original;
    }
  });
});
