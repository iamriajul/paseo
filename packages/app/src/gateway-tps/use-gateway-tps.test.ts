import { describe, expect, test } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { canFetchGatewayTps, pickGatewayTpsSample } from "./use-gateway-tps";

const client = {} as Pick<DaemonClient, "getGatewayTps">;

const ready = {
  client,
  isConnected: true,
  supportsGatewayTps: true,
  provider: "claude",
  model: "grok-4.6",
};

const sample = {
  model: "grok-4.6",
  at: "2026-09-28T10:00:00.000Z",
  durationMs: 4200,
  ttftMs: 600,
  generationMs: 3600,
  inputTokens: 1200,
  outputTokens: 900,
  tps: 250,
  stream: true,
};

describe("canFetchGatewayTps", () => {
  test("reads throughput for a connected gateway-routed model", () => {
    expect(canFetchGatewayTps(ready)).toBe(true);
  });

  test("does not read from a host without the capability or a disconnected host", () => {
    expect(canFetchGatewayTps({ ...ready, supportsGatewayTps: false })).toBe(false);
    expect(canFetchGatewayTps({ ...ready, isConnected: false })).toBe(false);
    expect(canFetchGatewayTps({ ...ready, client: null })).toBe(false);
  });

  test("does not read without a model the Gateway can resolve", () => {
    expect(canFetchGatewayTps({ ...ready, model: null })).toBe(false);
    expect(canFetchGatewayTps({ ...ready, provider: null })).toBe(false);
  });
});

describe("pickGatewayTpsSample", () => {
  test("returns the record when the host reports one", () => {
    expect(pickGatewayTpsSample({ requestId: "t1", supported: true, sample })).toBe(sample);
  });

  test("renders nothing for an unsupported host or a model with no record", () => {
    expect(pickGatewayTpsSample({ requestId: "t1", supported: false, sample: null })).toBeNull();
    expect(pickGatewayTpsSample(undefined)).toBeNull();
  });
});
