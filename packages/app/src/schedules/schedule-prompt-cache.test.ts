import { describe, expect, it } from "vitest";
import {
  applyPromptCacheChoice,
  readPromptCacheChoice,
  supportsPromptCacheChoice,
} from "./schedule-prompt-cache";

describe("schedule prompt cache choice", () => {
  it("reads unknown or missing values as Automatic with the default warm-up", () => {
    expect(readPromptCacheChoice(undefined)).toEqual({ ttl: "default", warmUp: null });
    expect(readPromptCacheChoice({ prompt_cache_ttl: "2h", cache_warm: "yes" })).toEqual({
      ttl: "default",
      warmUp: null,
    });
    expect(readPromptCacheChoice({ prompt_cache_ttl: "1h", cache_warm: true })).toEqual({
      ttl: "1h",
      warmUp: true,
    });
  });

  it("stores the window's warm-up default explicitly", () => {
    expect(
      applyPromptCacheChoice({ base: {}, choice: { ttl: "5m", warmUp: null }, supported: true }),
    ).toEqual({ prompt_cache_ttl: "5m", cache_warm: true });
    expect(
      applyPromptCacheChoice({ base: {}, choice: { ttl: "1h", warmUp: null }, supported: true }),
    ).toEqual({ prompt_cache_ttl: "1h", cache_warm: false });
  });

  it("drops both cache keys for Automatic or an unsupported model, keeping the rest", () => {
    const base = { fast_mode: true, prompt_cache_ttl: "5m", cache_warm: true };
    expect(
      applyPromptCacheChoice({ base, choice: { ttl: "default", warmUp: null }, supported: true }),
    ).toEqual({ fast_mode: true });
    expect(
      applyPromptCacheChoice({ base, choice: { ttl: "5m", warmUp: true }, supported: false }),
    ).toEqual({ fast_mode: true });
  });

  it("offers the controls only for first-party Claude models", () => {
    expect(supportsPromptCacheChoice("claude", "claude-opus-5-5")).toBe(true);
    expect(supportsPromptCacheChoice("claude", "glm-5.3")).toBe(false);
    expect(supportsPromptCacheChoice("codex", "claude-opus-5-5")).toBe(false);
  });
});
