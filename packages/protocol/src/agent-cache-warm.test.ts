import { describe, expect, it } from "vitest";
import {
  DEFAULT_CACHE_WARM_PING_PROMPT,
  DEFAULT_CACHE_WARM_MAX_PINGS,
  SUBAGENT_CACHE_WARM_MAX_PINGS,
  resolvePromptCacheWindows,
  isCacheWarmPrompt,
  isCacheWarmReply,
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
});
