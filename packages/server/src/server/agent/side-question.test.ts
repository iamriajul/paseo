import { describe, expect, test } from "vitest";
import { estimateSideQuestionCache, type SideQuestionCacheView } from "./side-question.js";

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function view(input: {
  lastRequestAt: string;
  tokens?: number;
  ttl?: "5m" | "1h";
  history?: SideQuestionCacheView["promptCache"] extends infer P
    ? P extends { history?: infer H }
      ? H
      : never
    : never;
}): SideQuestionCacheView {
  return {
    provider: "claude",
    config: { model: "claude-opus-5-5", featureValues: { prompt_cache_ttl: input.ttl ?? "5m" } },
    promptCache: {
      lastRequest: {
        at: input.lastRequestAt,
        turnId: null,
        isWarmPing: false,
        readTokens: input.tokens ?? 400_000,
        writeTokens: 12_000,
        uncachedTokens: 0,
      },
      history: input.history,
    },
  };
}

describe("estimateSideQuestionCache", () => {
  test("latest point inside the window reads the source's whole context", () => {
    expect(
      estimateSideQuestionCache({
        nowMs: NOW,
        point: "latest",
        boundaryAtMs: null,
        source: view({ lastRequestAt: minutesAgo(2) }),
        side: null,
      }),
    ).toEqual({ point: "latest", state: "warm", tokens: 412_000, expiredAgoMs: null });
  });

  test("latest point past the window rewrites it, and says how long ago it expired", () => {
    expect(
      estimateSideQuestionCache({
        nowMs: NOW,
        point: "latest",
        boundaryAtMs: null,
        source: view({ lastRequestAt: minutesAgo(17) }),
        side: null,
      }),
    ).toEqual({ point: "latest", state: "expired", tokens: 412_000, expiredAgoMs: 12 * 60_000 });
  });

  test("a 1h window is still warm after 17 minutes", () => {
    expect(
      estimateSideQuestionCache({
        nowMs: NOW,
        point: "latest",
        boundaryAtMs: null,
        source: view({ lastRequestAt: minutesAgo(17), ttl: "1h" }),
        side: null,
      }).state,
    ).toBe("warm");
  });

  test("an earlier point reads the entry of the request that ended that turn, not the latest", () => {
    const estimate = estimateSideQuestionCache({
      nowMs: NOW,
      point: "earlier",
      boundaryAtMs: NOW - 30 * 60_000,
      source: view({
        lastRequestAt: minutesAgo(1),
        history: [
          {
            at: minutesAgo(40),
            kind: "turn",
            readTokens: 100_000,
            writeTokens: 5_000,
            uncachedTokens: 0,
            gapMs: null,
          },
          {
            at: minutesAgo(31),
            kind: "turn",
            readTokens: 170_000,
            writeTokens: 10_000,
            uncachedTokens: 0,
            gapMs: 60_000,
          },
          {
            at: minutesAgo(1),
            kind: "turn",
            readTokens: 400_000,
            writeTokens: 12_000,
            uncachedTokens: 0,
            gapMs: 60_000,
          },
        ],
      }),
      side: null,
    });
    // The turn that ended 31 minutes ago wrote 180k tokens; its 5 minute window is long gone,
    // although the main session's cache is warm.
    expect(estimate).toEqual({
      point: "earlier",
      state: "expired",
      tokens: 180_000,
      expiredAgoMs: 26 * 60_000,
    });
  });

  test("a follow-up is judged by the side question's own last request", () => {
    expect(
      estimateSideQuestionCache({
        nowMs: NOW,
        point: "latest",
        boundaryAtMs: null,
        source: view({ lastRequestAt: minutesAgo(60) }),
        side: view({ lastRequestAt: minutesAgo(1), tokens: 90_000 }),
      }),
    ).toMatchObject({ state: "warm", tokens: 102_000 });
  });

  test("says unknown when the daemon has no request to judge by", () => {
    expect(
      estimateSideQuestionCache({
        nowMs: NOW,
        point: "latest",
        boundaryAtMs: null,
        source: { provider: "claude", config: null, promptCache: null },
        side: null,
      }),
    ).toEqual({ point: "latest", state: "unknown", tokens: null, expiredAgoMs: null });
  });
});
