import { describe, expect, it } from "vitest";
import {
  DEFAULT_CACHE_WARM_PING_PROMPT,
  DEFAULT_CACHE_WARM_MAX_PINGS,
  SUBAGENT_CACHE_WARM_MAX_PINGS,
  resolvePromptCacheWindows,
  isCacheWarmPrompt,
  isCacheWarmReply,
  isClaudeModel,
} from "./agent-cache-warm.js";

describe("agent-cache-warm protocol utilities", () => {
  it("resolves default 1h cache windows and 12-ping cap", () => {
    const resolved = resolvePromptCacheWindows({ isSubagent: false });
    expect(resolved.cacheWindowMs).toBe(60 * 60 * 1000);
    expect(resolved.warmIntervalMs).toBe(58 * 60 * 1000);
    expect(resolved.maxConsecutivePings).toBe(DEFAULT_CACHE_WARM_MAX_PINGS);
    expect(resolved.maxConsecutivePings).toBe(12);
  });

  it("resolves 5m cache windows and 10-ping cap for subagents", () => {
    const resolved = resolvePromptCacheWindows({ isSubagent: true });
    expect(resolved.cacheWindowMs).toBe(5 * 60 * 1000);
    expect(resolved.warmIntervalMs).toBe(4 * 60 * 1000);
    expect(resolved.maxConsecutivePings).toBe(SUBAGENT_CACHE_WARM_MAX_PINGS);
    expect(resolved.maxConsecutivePings).toBe(10);
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
