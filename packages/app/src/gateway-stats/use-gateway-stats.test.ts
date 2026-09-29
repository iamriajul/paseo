import { describe, expect, test } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  canFetchGatewayStats,
  GATEWAY_STATS_POLL_MS,
  pickGatewayStatsSample,
} from "./use-gateway-stats";

const client = {} as Pick<DaemonClient, "getGatewayStats">;

const ready = {
  client,
  isConnected: true,
  supportsGatewayStats: true,
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

describe("canFetchGatewayStats", () => {
  test("reads throughput for a connected gateway-routed model", () => {
    expect(canFetchGatewayStats(ready)).toBe(true);
  });

  test("does not read from a host without the capability or a disconnected host", () => {
    expect(canFetchGatewayStats({ ...ready, supportsGatewayStats: false })).toBe(false);
    expect(canFetchGatewayStats({ ...ready, isConnected: false })).toBe(false);
    expect(canFetchGatewayStats({ ...ready, client: null })).toBe(false);
  });

  test("does not read without a model the Gateway can resolve", () => {
    expect(canFetchGatewayStats({ ...ready, model: null })).toBe(false);
    expect(canFetchGatewayStats({ ...ready, provider: null })).toBe(false);
  });
});

describe("pickGatewayStatsSample", () => {
  test("returns the record when the host reports one", () => {
    expect(pickGatewayStatsSample({ requestId: "t1", supported: true, sample })).toBe(sample);
  });

  test("renders nothing for an unsupported host or a model with no record", () => {
    expect(pickGatewayStatsSample({ requestId: "t1", supported: false, sample: null })).toBeNull();
    expect(pickGatewayStatsSample(undefined)).toBeNull();
  });
});

describe("GATEWAY_STATS_POLL_MS", () => {
  test("polls often enough to read as live without flooding the socket", () => {
    // The read is our own in-process history, not an upstream call, so the
    // ceiling is render and transport cost rather than a provider rate limit.
    expect(GATEWAY_STATS_POLL_MS).toBeGreaterThanOrEqual(3_000);
    expect(GATEWAY_STATS_POLL_MS).toBeLessThanOrEqual(5_000);
  });
});
