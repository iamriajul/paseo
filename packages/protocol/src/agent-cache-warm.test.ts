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
});
