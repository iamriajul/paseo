import { describe, expect, it } from "vitest";
import {
  DEFAULT_CACHE_WARM_PING_PROMPT,
  resolvePromptCacheWindows,
  resolveCacheWarmEnabled,
  resolvePromptCacheAnchorMs,
  promptCacheHitRatio,
  isCacheWarmPrompt,
  isCacheWarmReply,
  isClaudeModel,
  recordPromptCacheRequest,
  PROMPT_CACHE_HISTORY_LIMIT,
  type AgentPromptCacheState,
  type PromptCacheRequestSample,
} from "./agent-cache-warm.js";

describe("agent-cache-warm protocol utilities", () => {
  it("resolves the 1h window: warm at 58m, 12-ping cap", () => {
    expect(resolvePromptCacheWindows("1h")).toEqual({
      cacheWindowMs: 60 * 60 * 1000,
      warmIntervalMs: 58 * 60 * 1000,
      maxConsecutivePings: 12,
    });
  });

  it("resolves the 5m window: warm at 4m30s, 10-ping cap", () => {
    expect(resolvePromptCacheWindows("5m")).toEqual({
      cacheWindowMs: 5 * 60 * 1000,
      warmIntervalMs: 270 * 1000,
      maxConsecutivePings: 10,
    });
  });

  it("has no window for Automatic, because Claude Code picks the TTL out of sight", () => {
    expect(resolvePromptCacheWindows("default")).toBeNull();
    expect(resolvePromptCacheWindows(undefined)).toBeNull();
    expect(resolvePromptCacheWindows("15m")).toBeNull();
  });

  it("enables warm-up only for an explicit window; 5m defaults on, 1h defaults off", () => {
    expect(resolveCacheWarmEnabled({ promptCacheTtl: "5m", explicitValue: undefined })).toBe(true);
    expect(resolveCacheWarmEnabled({ promptCacheTtl: "1h", explicitValue: undefined })).toBe(false);
    expect(resolveCacheWarmEnabled({ promptCacheTtl: "1h", explicitValue: true })).toBe(true);
    expect(resolveCacheWarmEnabled({ promptCacheTtl: "5m", explicitValue: false })).toBe(false);
    expect(resolveCacheWarmEnabled({ promptCacheTtl: "default", explicitValue: true })).toBe(false);
    expect(resolveCacheWarmEnabled({ promptCacheTtl: undefined, explicitValue: true })).toBe(false);
  });

  it("anchors on the latest request start, falling back to turn end", () => {
    const lastResponseAt = "2026-10-27T10:05:00.000Z";
    const sample = {
      at: "2026-10-27T10:02:00.000Z",
      turnId: "t1",
      isWarmPing: false,
      readTokens: 1,
      writeTokens: 0,
      uncachedTokens: 0,
    };
    expect(
      resolvePromptCacheAnchorMs({
        promptCache: { lastRequest: sample, turnFirstRequest: sample },
        lastResponseAt,
      }),
    ).toBe(Date.parse(sample.at));
    expect(resolvePromptCacheAnchorMs({ lastResponseAt })).toBe(Date.parse(lastResponseAt));
    expect(resolvePromptCacheAnchorMs({})).toBeNull();
  });

  it("computes the share of input served from cache", () => {
    expect(promptCacheHitRatio({ readTokens: 90, writeTokens: 8, uncachedTokens: 2 })).toBe(0.9);
    expect(promptCacheHitRatio({ readTokens: 0, writeTokens: 0, uncachedTokens: 0 })).toBeNull();
  });

  it("detects cache warm prompt correctly", () => {
    expect(isCacheWarmPrompt(DEFAULT_CACHE_WARM_PING_PROMPT)).toBe(true);
    expect(isCacheWarmPrompt(`  ${DEFAULT_CACHE_WARM_PING_PROMPT} \n `)).toBe(true);
    expect(isCacheWarmPrompt("Hello, what is the weather?")).toBe(false);
    expect(isCacheWarmPrompt(null)).toBe(false);
    expect(isCacheWarmPrompt(undefined)).toBe(false);
  });

  it("detects cache warm ok replies correctly", () => {
    expect(isCacheWarmReply("ok")).toBe(true);
    expect(isCacheWarmReply("OK")).toBe(true);
    expect(isCacheWarmReply("ok.")).toBe(true);
    expect(isCacheWarmReply("ok!")).toBe(true);
    expect(isCacheWarmReply("  ok  \n")).toBe(true);
    expect(isCacheWarmReply("I did the changes as requested.")).toBe(false);
    expect(isCacheWarmReply(null)).toBe(false);
    expect(isCacheWarmReply(undefined)).toBe(false);
  });

  describe("isClaudeModel", () => {
    it("identifies first-party Claude models", () => {
      expect(isClaudeModel("claude-opus-5-5")).toBe(true);
      expect(isClaudeModel("claude-sonnet-5-5")).toBe(true);
      expect(isClaudeModel("claude-haiku-5-5")).toBe(true);
      expect(isClaudeModel("Claude-3-7-Sonnet")).toBe(true);
      expect(isClaudeModel("claude-3-5-haiku-20241022")).toBe(true);
      expect(isClaudeModel("openrouter/anthropic/claude-opus-4-8")).toBe(true);
      expect(isClaudeModel("anthropic/claude-3-7-sonnet")).toBe(true);
      expect(isClaudeModel("us.anthropic.claude-opus-4-7[1m]")).toBe(true);
      expect(isClaudeModel("opus")).toBe(true);
      expect(isClaudeModel("sonnet")).toBe(true);
      expect(isClaudeModel("haiku")).toBe(true);
      expect(isClaudeModel("fable")).toBe(true);
      expect(isClaudeModel(null)).toBe(true);
      expect(isClaudeModel(undefined)).toBe(true);
      expect(isClaudeModel("")).toBe(true);
    });

    it("rejects non-Claude models", () => {
      expect(isClaudeModel("gemini-3.8-flash-high")).toBe(false);
      expect(isClaudeModel("openrouter/google/gemini-2.0-flash")).toBe(false);
      expect(isClaudeModel("codex-auto-review")).toBe(false);
      expect(isClaudeModel("gpt-6-luna")).toBe(false);
      expect(isClaudeModel("qwen3.8-max")).toBe(false);
      expect(isClaudeModel("glm-5.3")).toBe(false);
      expect(isClaudeModel("claude-fable-5-dd-hsalf-3.5-mlg")).toBe(false);
    });
  });

  describe("recordPromptCacheRequest", () => {
    const minute = 60_000;
    function request(
      atMinutes: number,
      turnId: string,
      options: { isWarmPing?: boolean; readTokens?: number } = {},
    ): PromptCacheRequestSample {
      return {
        at: new Date(atMinutes * minute).toISOString(),
        turnId,
        isWarmPing: options.isWarmPing ?? false,
        readTokens: options.readTokens ?? 900,
        writeTokens: 100,
        uncachedTokens: 0,
      };
    }
    function replay(samples: PromptCacheRequestSample[]): AgentPromptCacheState | undefined {
      return samples.reduce<AgentPromptCacheState | undefined>(
        (state, sample) => recordPromptCacheRequest(state, sample),
        undefined,
      );
    }

    function timing(state: AgentPromptCacheState | undefined) {
      return state?.history?.map(({ kind, gapMs, awayMs }) => ({ kind, gapMs, awayMs }));
    }

    it("records every request with its gap, and a turn's time away since real activity", () => {
      const state = replay([
        request(0, "t1"),
        request(1, "t1"),
        request(5.5, "p1", { isWarmPing: true }),
        request(10, "p2", { isWarmPing: true }),
        request(12, "t2", { readTokens: 0 }),
        request(13, "t2"),
      ]);
      expect(timing(state)).toEqual([
        { kind: "turn", gapMs: null, awayMs: undefined },
        { kind: "request", gapMs: minute, awayMs: undefined },
        { kind: "warm-up", gapMs: 4.5 * minute, awayMs: undefined },
        { kind: "warm-up", gapMs: 4.5 * minute, awayMs: undefined },
        { kind: "turn", gapMs: 2 * minute, awayMs: 11 * minute },
        { kind: "request", gapMs: minute, awayMs: undefined },
      ]);
      expect(state?.history?.[4]?.readTokens).toBe(0);
      expect(state?.turnFirstRequest.turnId).toBe("t2");
    });

    it("keeps only the latest prompts", () => {
      const samples: PromptCacheRequestSample[] = [];
      for (let index = 0; index < PROMPT_CACHE_HISTORY_LIMIT + 5; index += 1) {
        samples.push(request(index, `t${index}`));
      }
      const history = replay(samples)?.history ?? [];
      expect(history).toHaveLength(PROMPT_CACHE_HISTORY_LIMIT);
      expect(history.at(-1)?.at).toBe(samples.at(-1)?.at);
    });
  });
});
