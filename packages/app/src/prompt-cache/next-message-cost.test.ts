import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { resolveNextMessageCost } from "./next-message-cost";
import { describeNextMessage } from "./next-message-cost-section";
import { resolvePromptCacheView } from "./use-prompt-cache";

const NOW = new Date("2026-11-03T10:00:00.000Z").getTime();
const MINUTE = 60_000;

function stoppedOpusAgent(lastRequestMinutesAgo: number, overrides: Partial<Agent> = {}): Agent {
  const sample = {
    at: new Date(NOW - lastRequestMinutesAgo * MINUTE).toISOString(),
    turnId: "turn-1",
    isWarmPing: false,
    readTokens: 449_000,
    writeTokens: 1_000,
    uncachedTokens: 0,
  };
  return {
    id: "agent-1",
    provider: "claude",
    model: "claude-opus-5-5[1m]",
    status: "closed",
    runtimeActive: false,
    labels: {},
    pendingPermissions: [],
    features: [{ type: "select", id: "prompt_cache_ttl", value: "5m" }],
    promptCache: { lastRequest: sample, turnFirstRequest: sample },
    ...overrides,
  } as unknown as Agent;
}

function costOf(agent: Agent) {
  return resolveNextMessageCost({ agent, view: resolvePromptCacheView(agent, NOW) });
}

describe("resolveNextMessageCost", () => {
  it("prices waking a stopped agent whose cache expired as a full write", () => {
    const cost = costOf(stoppedOpusAgent(20));
    expect(cost).toMatchObject({ contextTokens: 450_000, cache: { kind: "cold" } });
    expect(cost?.runtimeActive).toBe(false);
    expect(cost?.coldUsd).toBeCloseTo(2.25, 6);
    expect(describeNextMessage(cost!).headline).toBe("Writes 450k again ≈ $2.25");
  });

  it("prices a live cache as a read and says how long it stays warm", () => {
    const cost = costOf(stoppedOpusAgent(1));
    expect(cost?.cache).toEqual({ kind: "warm", remainingMs: 4 * MINUTE });
    expect(cost?.warmUsd).toBeCloseTo(0.09, 6);
  });

  it("falls back to the last context report when no request was sampled", () => {
    const cost = costOf(
      stoppedOpusAgent(20, {
        promptCache: undefined,
        lastUsage: { contextWindowUsedTokens: 120_000, contextWindowMaxTokens: 1_000_000 },
      }),
    );
    expect(cost?.contextTokens).toBe(120_000);
  });

  it("shows nothing for a model it has no price for", () => {
    expect(costOf(stoppedOpusAgent(20, { model: "gpt-5" }))).toBeNull();
  });
});
