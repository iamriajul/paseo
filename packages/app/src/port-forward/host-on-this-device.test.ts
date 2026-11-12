import { describe, expect, it } from "vitest";
import { isHostOnThisDevice } from "./host-on-this-device";

describe("isHostOnThisDevice", () => {
  it("is true only for a host reached on this device's loopback or a local socket", () => {
    const direct = (endpoint: string) =>
      isHostOnThisDevice({ type: "directTcp", endpoint, display: endpoint });
    expect(direct("127.0.0.1:6767")).toBe(true);
    expect(direct("localhost:6767")).toBe(true);
    expect(direct("[::1]:6767")).toBe(true);
    expect(direct("192.168.1.20:6767")).toBe(false);
    expect(direct("mac-mini.tail123.ts.net:6767")).toBe(false);
    expect(
      isHostOnThisDevice({ type: "directSocket", endpoint: "/tmp/p.sock", display: "socket" }),
    ).toBe(true);
    expect(
      isHostOnThisDevice({ type: "relay", endpoint: "relay.paseo.sh", display: "relay" }),
    ).toBe(false);
    expect(isHostOnThisDevice(null)).toBe(false);
  });
});
