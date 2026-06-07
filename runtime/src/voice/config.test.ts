import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderLiveKitYaml,
  ensureConfigWritten,
  DEFAULT_PORT_PLAN,
  DEFAULT_WEBHOOK_URL,
} from "./config";

const sample = {
  apiKey: "uncorded-deadbeefdeadbeef",
  apiSecret: "f".repeat(64),
  ports: DEFAULT_PORT_PLAN,
};

describe("renderLiveKitYaml", () => {
  test("includes the api key/secret pair, signaling port, and the UDP MUX port", () => {
    const yaml = renderLiveKitYaml(sample);
    expect(yaml).toContain(`port: ${DEFAULT_PORT_PLAN.signaling}`);
    expect(yaml).toContain(`tcp_port: ${DEFAULT_PORT_PLAN.rtcTcp}`);
    expect(yaml).toContain(`udp_port: ${DEFAULT_PORT_PLAN.rtcUdpPort}`);
    expect(yaml).toContain(`${sample.apiKey}: ${sample.apiSecret}`);
  });

  test("never emits port_range_start/end — Amendment B switched to UDP MUX", () => {
    // Regression guard: port-range mode binds UDP lazily per-session, so
    // Central's cold reachability probe can never observe a listening
    // socket. spec-24 Amendment B mandates `rtc.udp_port` (UDP MUX). Tests
    // here lock the YAML keys so an accidental revert is caught.
    const yaml = renderLiveKitYaml(sample);
    expect(yaml).not.toContain("port_range_start");
    expect(yaml).not.toContain("port_range_end");
  });

  test("emits embedded TURN block on turnUdpPort — Amendment C", () => {
    // spec-24 Amendment C: pion ICE drops cold STUN at the MUX socket,
    // so Central probes LiveKit's embedded TURN STUN responder instead
    // (RFC 5766 §6.5). The TURN block must enable the server and bind to
    // the configured UDP port (default 3478). Locks both the structure
    // and the port so an accidental revert (e.g. forgetting to enable
    // turn) is caught immediately.
    const yaml = renderLiveKitYaml(sample);
    expect(yaml).toContain("turn:");
    expect(yaml).toContain("  enabled: true");
    expect(yaml).toContain(`  udp_port: ${DEFAULT_PORT_PLAN.turnUdpPort}`);
    // No TLS port — we don't ship cert plumbing and TLS has its own
    // reachability story. Amendment C scope is explicitly UDP-only.
    expect(yaml).not.toContain("tls_port:");
    expect(yaml).not.toContain("cert_file");
    expect(yaml).not.toContain("key_file");
  });

  test("turnUdpPort override is honored", () => {
    const yaml = renderLiveKitYaml({
      ...sample,
      ports: { ...sample.ports, turnUdpPort: 19302 },
    });
    expect(yaml).toContain("  udp_port: 19302");
    // The MUX `udp_port` and the TURN `udp_port` share the YAML key but
    // live under different parents — both appear in the file, and we
    // care that the TURN one tracks the input.
    expect(yaml).toMatch(/turn:\s*\n\s+enabled: true\s*\n\s+udp_port: 19302/);
  });

  test("is deterministic (no timestamps, no randoms)", () => {
    const a = renderLiveKitYaml(sample);
    const b = renderLiveKitYaml(sample);
    expect(a).toBe(b);
  });

  test("emits a webhook block with the same apiKey as keys: and the default loopback URL", () => {
    const yaml = renderLiveKitYaml(sample);
    expect(yaml).toContain("webhook:");
    expect(yaml).toContain(`api_key: ${sample.apiKey}`);
    expect(yaml).toContain(`- ${DEFAULT_WEBHOOK_URL}`);
    // pr-4-voice-contract.md §5: receive URL is loopback so traffic
    // never leaves the runtime container's network namespace.
    expect(DEFAULT_WEBHOOK_URL.startsWith("http://127.0.0.1:")).toBe(true);
  });

  test("webhookUrl override is honored", () => {
    const yaml = renderLiveKitYaml({ ...sample, webhookUrl: "http://127.0.0.1:9999/x" });
    expect(yaml).toContain("- http://127.0.0.1:9999/x");
    expect(yaml).not.toContain(DEFAULT_WEBHOOK_URL);
  });

  test("never emits nat_1_to_1_ips — the field was removed in LiveKit v1.11.0", () => {
    // Regression guard: an earlier render emitted this field and crashed
    // the supervisor on startup. v1.11.0's RTCConfig accepts node_ip
    // instead, which we emit only when an internalIp is explicitly
    // supplied (see test below).
    const yaml = renderLiveKitYaml({ ...sample, internalIp: "192.168.1.221" });
    expect(yaml).not.toContain("nat_1_to_1_ips");
  });

  test("emits node_ip when internalIp is provided; omits it otherwise", () => {
    expect(renderLiveKitYaml(sample)).not.toContain("node_ip");
    const withIp = renderLiveKitYaml({ ...sample, internalIp: "192.168.1.221" });
    expect(withIp).toContain("node_ip: 192.168.1.221");
    // node_ip lives under the rtc: block so LiveKit advertises it as the
    // host ICE candidate.
    expect(withIp).toMatch(/rtc:[\s\S]*node_ip: 192\.168\.1\.221/);
  });
});

describe("ensureConfigWritten", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uncorded-voice-cfg-"));
    path = join(dir, "livekit.yaml");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("first call writes the file", () => {
    const wrote = ensureConfigWritten(sample, path);
    expect(wrote).toBe(true);
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).toBe(renderLiveKitYaml(sample));
  });

  test("identical second call is a no-op (cache hit)", () => {
    expect(ensureConfigWritten(sample, path)).toBe(true);
    expect(ensureConfigWritten(sample, path)).toBe(false);
  });

  test("rotated secret triggers rewrite", () => {
    expect(ensureConfigWritten(sample, path)).toBe(true);
    const rotated = { ...sample, apiSecret: "a".repeat(64) };
    expect(ensureConfigWritten(rotated, path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(rotated.apiSecret);
  });

  test("changed port plan triggers rewrite", () => {
    expect(ensureConfigWritten(sample, path)).toBe(true);
    const remapped = { ...sample, ports: { ...sample.ports, signaling: 9000 } };
    expect(ensureConfigWritten(remapped, path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("port: 9000");
  });

  test("changed webhookUrl triggers rewrite", () => {
    expect(ensureConfigWritten(sample, path)).toBe(true);
    const repointed = { ...sample, webhookUrl: "http://127.0.0.1:4444/wh" };
    expect(ensureConfigWritten(repointed, path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("- http://127.0.0.1:4444/wh");
  });

  test("adding internalIp triggers rewrite with node_ip", () => {
    expect(ensureConfigWritten(sample, path)).toBe(true);
    const withIp = { ...sample, internalIp: "192.168.1.221" };
    expect(ensureConfigWritten(withIp, path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("node_ip: 192.168.1.221");
  });

  test("hand-edited file is healed back to expected content", () => {
    expect(ensureConfigWritten(sample, path)).toBe(true);
    writeFileSync(path, "tampered: true\n");
    expect(ensureConfigWritten(sample, path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(renderLiveKitYaml(sample));
  });

  test("file mode is 0600 on POSIX (skipped on Windows)", () => {
    if (process.platform === "win32") return;
    ensureConfigWritten(sample, path);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
