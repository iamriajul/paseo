import { describe, expect, it } from "vitest";
import type { AgentPromptCacheState } from "@getpaseo/protocol/agent-cache-warm";
import { resolvePromptCacheAutoCompact } from "./use-prompt-cache-auto-compact";

function cacheWithContext(readTokens: number, writeTokens: number): AgentPromptCacheState {
  const sample = {
    at: "2026-11-01T10:00:00.000Z",
    turnId: "turn-1",
    isWarmPing: false,
    readTokens,
    writeTokens,
    uncachedTokens: 0,
  };
  return { lastRequest: sample, turnFirstRequest: sample };
}

describe("resolvePromptCacheAutoCompact", () => {
  it("follows the host default until the agent makes its own choice", () => {
    const followsHost = resolvePromptCacheAutoCompact({
      agent: { promptCache: cacheWithContext(250_000, 0) },
      hostDefault: true,
    });
    expect(followsHost).toMatchObject({ enabled: true, overridden: false, largeEnough: true });

    const overridden = resolvePromptCacheAutoCompact({
      agent: { cacheAutoCompact: false, promptCache: cacheWithContext(250_000, 0) },
      hostDefault: true,
    });
    expect(overridden).toMatchObject({ enabled: false, overridden: true });
  });

  it("reports the context the cache holds, and whether it is past the 200k minimum", () => {
    const small = resolvePromptCacheAutoCompact({
      agent: { promptCache: cacheWithContext(150_000, 10_000) },
      hostDefault: true,
    });
    expect(small).toMatchObject({ contextTokens: 160_000, largeEnough: false });
  });

  it("has no context before the first request", () => {
    expect(resolvePromptCacheAutoCompact({ agent: undefined, hostDefault: undefined })).toEqual({
      enabled: false,
      overridden: false,
      hostDefault: false,
      contextTokens: null,
      largeEnough: false,
    });
  });
});
