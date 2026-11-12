import { describe, expect, it } from "vitest";
import { LoopbackPortSet, loopbackPortFromUrl } from "./loopback-ports.js";

describe("loopbackPortFromUrl", () => {
  it("reads the port of loopback http and WebSocket URLs, with scheme defaults", () => {
    expect(loopbackPortFromUrl("http://localhost:5173/src/main.ts")).toBe(5173);
    expect(loopbackPortFromUrl("ws://127.0.0.1:24678/")).toBe(24678);
    expect(loopbackPortFromUrl("http://app.localhost/")).toBe(80);
    expect(loopbackPortFromUrl("wss://[::1]/socket")).toBe(443);
  });

  it("ignores other hosts, schemes and unspecified addresses", () => {
    expect(loopbackPortFromUrl("https://example.com:8443/")).toBeNull();
    expect(loopbackPortFromUrl("http://0.0.0.0:3000/")).toBeNull();
    expect(loopbackPortFromUrl("data:text/html,hi")).toBeNull();
    expect(loopbackPortFromUrl("not a url")).toBeNull();
  });
});

describe("LoopbackPortSet", () => {
  it("collects request and WebSocket ports from Network events, and claims every Network event", () => {
    const set = new LoopbackPortSet();
    expect(
      set.observe({
        method: "Network.requestWillBeSent",
        params: { request: { url: "http://localhost:8080/api" } },
      }),
    ).toBe(true);
    set.observe({ method: "Network.webSocketCreated", params: { url: "ws://localhost:3000/" } });
    set.observe({
      method: "Network.requestWillBeSent",
      params: { request: { url: "http://localhost:8080/again" } },
    });
    expect(set.observe({ method: "Network.responseReceived", params: {} })).toBe(true);
    expect(set.observe({ method: "Page.loadEventFired", params: {} })).toBe(false);
    expect(set.list()).toEqual([3000, 8080]);
  });
});
