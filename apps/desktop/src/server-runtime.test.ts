import { describe, expect, it } from "bun:test";

// electron is stubbed globally by the test preload (apps/desktop/test/
// preload-electron.ts), so importing server-runtime (which imports `app`) links
// cleanly. hostGatewayAddHosts is pure — it takes isPackaged as an argument
// rather than reading app.isPackaged — so these cases are deterministic
// regardless of test file order.
import { hostGatewayAddHosts } from "./server-runtime";

describe("hostGatewayAddHosts", () => {
  it("maps host.docker.internal to the host gateway in dev (not packaged)", () => {
    expect(hostGatewayAddHosts(false)).toEqual(["host.docker.internal:host-gateway"]);
  });

  it("adds no host mappings in packaged builds", () => {
    expect(hostGatewayAddHosts(true)).toEqual([]);
  });
});
