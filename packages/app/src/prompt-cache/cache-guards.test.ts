import { describe, expect, test } from "vitest";
import { resolveColdSendGuard, resolveModelSwitchGuard } from "./cache-guards";
import type { PromptCacheView } from "./use-prompt-cache";

const opus = { provider: "claude", modelId: "claude-opus-5-5" };
const warmup: NonNullable<PromptCacheView["warmup"]> = {
  enabled: true,
  plan: { kind: "next-ping", remainingMs: 60_000 },
  pingsUsed: 0,
  maxPings: 12,
  windowMaxPings: 12,
  coverEndsInMs: null,
  totalPings: 0,
};

describe("resolveModelSwitchGuard", () => {
  test("asks while warm-up keeps a live cache", () => {
    expect(
      resolveModelSwitchGuard({
        agent: opus,
        nextModelId: "claude-fable-5-1",
        view: { status: { kind: "warm", remainingMs: 120_000 }, warmup },
      }),
    ).toBe(120_000);
  });

  test("switches at once without warm-up, after expiry, or for the same model", () => {
    const live = { kind: "warm", remainingMs: 120_000 } as const;
    expect(
      resolveModelSwitchGuard({
        agent: opus,
        nextModelId: "claude-fable-5-1",
        view: { status: live, warmup: { ...warmup, enabled: false } },
      }),
    ).toBeNull();
    expect(
      resolveModelSwitchGuard({
        agent: opus,
        nextModelId: "claude-fable-5-1",
        view: { status: { kind: "expired" }, warmup },
      }),
    ).toBeNull();
    expect(
      resolveModelSwitchGuard({
        agent: opus,
        nextModelId: opus.modelId,
        view: { status: live, warmup },
      }),
    ).toBeNull();
  });

  test("never asks for another provider", () => {
    expect(
      resolveModelSwitchGuard({
        agent: { provider: "codex", modelId: "gpt-5.5" },
        nextModelId: "gpt-5.5-mini",
        view: { status: { kind: "warm", remainingMs: 120_000 }, warmup },
      }),
    ).toBeNull();
  });
});

describe("resolveColdSendGuard", () => {
  test("asks before a prompt reaches an expired cache", () => {
    expect(
      resolveColdSendGuard({
        agent: opus,
        text: "carry on",
        view: { status: { kind: "expired" }, lastTurnCompacted: false },
      }),
    ).toBe(true);
  });

  test("sends at once while warm, on Haiku, or for a slash command", () => {
    expect(
      resolveColdSendGuard({
        agent: opus,
        text: "carry on",
        view: { status: { kind: "warm", remainingMs: 1_000 }, lastTurnCompacted: false },
      }),
    ).toBe(false);
    expect(
      resolveColdSendGuard({
        agent: { provider: "claude", modelId: "claude-haiku-5-5" },
        text: "carry on",
        view: { status: { kind: "expired" }, lastTurnCompacted: false },
      }),
    ).toBe(false);
    expect(
      resolveColdSendGuard({
        agent: opus,
        text: " /compact",
        view: { status: { kind: "expired" }, lastTurnCompacted: false },
      }),
    ).toBe(false);
  });

  test("sends at once right after a compaction, the user's or the idle cap's", () => {
    expect(
      resolveColdSendGuard({
        agent: opus,
        text: "carry on",
        view: { status: { kind: "expired" }, lastTurnCompacted: true },
      }),
    ).toBe(false);
  });
});
