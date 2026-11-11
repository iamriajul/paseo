import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPromptCacheState, CacheWarmStop } from "@getpaseo/protocol/agent-cache-warm";
import {
  AgentCacheWarmManager,
  WARM_UP_ACCOUNT_RETRY_MS,
  CACHE_WARM_PERMISSION_PAUSE_MESSAGE,
  CACHE_WARM_QUESTION_PAUSE_MESSAGE,
  DEFAULT_CACHE_WARM_PING_PROMPT,
} from "./agent-cache-warm.js";
import { AgentStorage, type StoredAgentRecord } from "./agent-storage.js";
import { AgentManager, type ManagedAgent } from "./agent-manager.js";
import type { AgentPersistenceHandle, AgentStreamEvent } from "./agent-sdk-types.js";
import type { WarmUpAccountBlock } from "./gateway/warm-up-account.js";

const MINUTE = 60 * 1000;
const START = new Date("2026-10-27T10:00:00.000Z").getTime();

function promptCacheAt(atMs: number, readTokens = 1000): AgentPromptCacheState {
  const sample = {
    at: new Date(atMs).toISOString(),
    turnId: "turn-1",
    isWarmPing: false,
    readTokens,
    writeTokens: 10,
    uncachedTokens: 1,
  };
  return { lastRequest: sample, turnFirstRequest: sample };
}

interface HarnessOptions {
  onIdleCapCompaction?: (agentId: string) => Promise<void>;
  ttl?: "5m" | "1h" | "default";
  cacheWarm?: boolean;
  lifecycle?: ManagedAgent["lifecycle"];
  model?: string;
  delegated?: boolean;
  pending?: Array<{
    id: string;
    kind?: string;
    name?: string;
    title?: string;
    input?: Record<string, unknown>;
  }>;
  hasInFlightRun?: boolean;
  requestAtMs?: number | null;
  lastResponseAtMs?: number | null;
  observedTtl?: "5m" | "1h";
  autoCompact?: boolean;
  autoCompactByDefault?: boolean;
  /** The agent's own warm-up cap per idle stretch. */
  maxPings?: unknown;
  /** Cache reads of every request, so roughly the context size. */
  contextTokens?: number;
  /** The session warms through a throwaway fork instead of a ping turn. */
  forkWarm?: boolean;
  /** The host lifts the idle cap while a child of this agent can still report. */
  warmsPastCap?: () => boolean;
  /** Host warm-up mode: true for v2 (fork), false for v1 (ping). */
  warmsThroughFork?: () => boolean;
  /** The serving account check the manager runs right before a warm-up is sent. */
  readAccountBlock?: (agentId: string) => Promise<WarmUpAccountBlock | null>;
}

function buildAgent(options: HarnessOptions): ManagedAgent {
  const featureValues: Record<string, unknown> = { prompt_cache_ttl: options.ttl ?? "1h" };
  if (options.cacheWarm !== undefined) {
    featureValues.cache_warm = options.cacheWarm;
  }
  if (options.autoCompact !== undefined) {
    featureValues.cache_auto_compact = options.autoCompact;
  }
  if (options.maxPings !== undefined) {
    featureValues.cache_warm_max_pings = options.maxPings;
  }
  const requestAtMs = options.requestAtMs === undefined ? START : options.requestAtMs;
  const lastResponseAtMs = options.lastResponseAtMs ?? requestAtMs;
  return {
    id: "agent-1",
    provider: "claude",
    cwd: "/test",
    config: { provider: "claude", cwd: "/test", model: options.model, featureValues },
    lifecycle: options.lifecycle ?? "idle",
    pendingPermissions: new Map((options.pending ?? []).map((request) => [request.id, request])),
    lastResponseAt: lastResponseAtMs === null ? null : new Date(lastResponseAtMs),
    promptCache:
      requestAtMs === null
        ? undefined
        : {
            ...promptCacheAt(requestAtMs, options.contextTokens),
            observedTtl: options.observedTtl,
          },
    labels: options.delegated ? { "paseo.parent-agent-id": "parent-1" } : {},
  } as unknown as ManagedAgent;
}

function createHarness(options: HarnessOptions = {}) {
  const agent = buildAgent(options);
  const sendPrompt = vi.fn(async () => {
    // A ping that reaches Anthropic produces a message_start, which moves the anchor.
    agent.promptCache = promptCacheAt(Date.now(), options.contextTokens);
    return { disposition: "turn_started" as const };
  });
  const setAgentFeature = vi.fn(async (_id: string, featureId: string, value: unknown) => {
    agent.config.featureValues = { ...agent.config.featureValues, [featureId]: value };
  });
  const warmPromptCache = vi.fn(async () => {
    // The fork's request reads the cache, which moves the anchor like any request.
    agent.promptCache = promptCacheAt(Date.now(), options.contextTokens);
    return true;
  });
  const setCacheWarmPause = vi.fn((_id: string, pause: WarmUpAccountBlock | null) => {
    agent.cacheWarmPause = pause ?? undefined;
  });
  const recordCacheWarmStop = vi.fn((_id: string, _stop: CacheWarmStop) => {});
  const respondToPermission = vi.fn(async () => {
    agent.pendingPermissions.clear();
    agent.promptCache = promptCacheAt(Date.now());
  });
  const manager = new AgentCacheWarmManager({
    agentManager: {
      getAgent: (id: string) => (id === agent.id ? agent : null),
      hasInFlightRun: () => options.hasInFlightRun ?? false,
      canWarmPromptCache: () => options.forkWarm ?? false,
      warmPromptCache,
      respondToPermission,
      markQuestionClosed: () => {
        if (agent.promptCache) {
          agent.promptCache = { ...agent.promptCache, questionClosedAt: new Date().toISOString() };
        }
      },
      markPermissionClosed: (_id: string, closed: { tool: string; command?: string }) => {
        if (agent.promptCache) {
          agent.promptCache = {
            ...agent.promptCache,
            permissionClosed: { at: new Date().toISOString(), ...closed },
          };
        }
      },
      listAgents: () => [agent],
      setAgentFeature,
      setCacheWarmPause,
      recordCacheWarmStop,
      setCacheWarmCounts: (
        _id: string,
        counts: { consecutiveWarmPings: number; totalWarmPings?: number },
      ) => {
        agent.consecutiveWarmPings = counts.consecutiveWarmPings;
        if (counts.totalWarmPings !== undefined) agent.totalWarmPings = counts.totalWarmPings;
      },
    } as unknown as AgentManager,
    agentStorage: { list: async () => [] } as unknown as AgentStorage,
    logger: pino({ level: "silent" }),
    sendPrompt,
    isCacheAutoCompactByDefault: () => options.autoCompactByDefault ?? false,
    onIdleCapCompaction: options.onIdleCapCompaction,
    warmsPastCap: options.warmsPastCap,
    warmsThroughFork: options.warmsThroughFork,
    readAccountBlock: options.readAccountBlock,
  });
  return {
    manager,
    agent,
    sendPrompt,
    respondToPermission,
    setAgentFeature,
    warmPromptCache,
    setCacheWarmPause,
    recordCacheWarmStop,
  };
}

/** The reasons of the stops the manager journaled, oldest first. */
function stopReasons(recordCacheWarmStop: { mock: { calls: unknown[] } }): string[] {
  const calls = recordCacheWarmStop.mock.calls as Array<[string, CacheWarmStop]>;
  return calls.map(([, stop]) => stop.reason);
}

/** The account check's answer, as a stub the harness can inject. */
function answersAccountBlock(
  block: WarmUpAccountBlock | null,
): (agentId: string) => Promise<WarmUpAccountBlock | null> {
  return async () => block;
}

async function failsAccountCheck(): Promise<WarmUpAccountBlock | null> {
  throw new Error("gateway unreachable");
}

async function settlesImmediately(): Promise<void> {}

function sentPrompts(sendPrompt: { mock: { calls: unknown[] } }): string[] {
  const calls = sendPrompt.mock.calls as Array<[{ prompt: string }]>;
  return calls.map(([input]) => input.prompt);
}

describe("AgentCacheWarmManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("warms a running turn through a fork, sending the agent nothing", async () => {
    const { manager, sendPrompt, warmPromptCache } = createHarness({
      ttl: "5m",
      forkWarm: true,
      lifecycle: "running",
      hasInFlightRun: true,
    });
    expect(manager.schedule("agent-1")).toBe(true);

    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(warmPromptCache).toHaveBeenCalledTimes(1);
    expect(sendPrompt).not.toHaveBeenCalled();

    // No turn follows a fork, so the warm-up arms the next one itself.
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(warmPromptCache).toHaveBeenCalledTimes(2);
  });

  it("keeps an open question open and its cache warm through a fork", async () => {
    const { manager, respondToPermission, warmPromptCache } = createHarness({
      ttl: "5m",
      forkWarm: true,
      pending: [{ id: "question-1", name: "AskUserQuestion", kind: "question" }],
    });
    manager.schedule("agent-1");

    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(warmPromptCache).toHaveBeenCalledTimes(1);
    expect(respondToPermission).not.toHaveBeenCalled();
  });

  it("does not compact at the cap while a question waits, so the cache expires instead", async () => {
    const { manager, agent, sendPrompt, warmPromptCache } = createHarness({
      ttl: "5m",
      forkWarm: true,
      autoCompact: true,
      contextTokens: 300_000,
      pending: [{ id: "question-1", name: "AskUserQuestion", kind: "question" }],
    });
    agent.consecutiveWarmPings = 10;
    expect(manager.schedule("agent-1")).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(warmPromptCache).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  describe("serving account check", () => {
    const cooldown: WarmUpAccountBlock = {
      reason: "cooldown",
      account: "u***a@example.com",
      until: "2026-10-27T10:30:00.000Z",
    };
    const usedUp: WarmUpAccountBlock = {
      reason: "quota",
      account: "u***a@example.com",
      window: "5h",
      until: "2026-10-27T14:00:00.000Z",
    };

    it("skips a ping and pauses while the serving account cools down, until a request of its own", async () => {
      const readAccountBlock = vi.fn(answersAccountBlock(cooldown));
      const { manager, agent, sendPrompt, setCacheWarmPause } = createHarness({
        ttl: "5m",
        readAccountBlock,
      });
      manager.schedule("agent-1");

      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      expect(readAccountBlock).toHaveBeenCalledWith("agent-1");
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(setCacheWarmPause).toHaveBeenLastCalledWith("agent-1", cooldown);
      // Paused: no further warm-up is armed for this idle stretch.
      expect(manager.schedule("agent-1")).toBe(false);
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(sendPrompt).not.toHaveBeenCalled();

      // The agent's next request of its own resumes warm-up, and the check runs again.
      readAccountBlock.mockResolvedValue(null);
      agent.promptCache = promptCacheAt(Date.now());
      manager.onRequestRecorded("agent-1");
      expect(setCacheWarmPause).toHaveBeenLastCalledWith("agent-1", null);
      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      expect(sendPrompt).toHaveBeenCalledTimes(1);
    });

    it("skips a fork warm-up while one of the account's quota windows is used up", async () => {
      const { manager, warmPromptCache, setCacheWarmPause } = createHarness({
        ttl: "5m",
        forkWarm: true,
        readAccountBlock: answersAccountBlock(usedUp),
      });
      manager.schedule("agent-1");

      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      expect(warmPromptCache).not.toHaveBeenCalled();
      expect(setCacheWarmPause).toHaveBeenLastCalledWith("agent-1", usedUp);
    });

    it("skips the idle-cap compaction too, which would reach the same blocked account", async () => {
      const onIdleCapCompaction = vi.fn(settlesImmediately);
      const { manager, agent, sendPrompt } = createHarness({
        ttl: "5m",
        autoCompact: true,
        contextTokens: 300_000,
        onIdleCapCompaction,
        readAccountBlock: answersAccountBlock(usedUp),
      });
      agent.consecutiveWarmPings = 10;
      manager.schedule("agent-1");

      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      expect(onIdleCapCompaction).not.toHaveBeenCalled();
      expect(sendPrompt).not.toHaveBeenCalled();
    });

    it("warms as before when the account is not blocked", async () => {
      const { manager, sendPrompt, setCacheWarmPause } = createHarness({
        ttl: "5m",
        readAccountBlock: answersAccountBlock(null),
      });
      manager.schedule("agent-1");

      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      expect(sentPrompts(sendPrompt)).toEqual([DEFAULT_CACHE_WARM_PING_PROMPT]);
      expect(setCacheWarmPause).not.toHaveBeenCalled();
    });

    it("journals why a blocked account left the cache to expire, with the account", async () => {
      const { manager, recordCacheWarmStop } = createHarness({
        ttl: "5m",
        readAccountBlock: answersAccountBlock(usedUp),
      });
      manager.schedule("agent-1");

      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      expect(recordCacheWarmStop).toHaveBeenCalledTimes(1);
      expect(recordCacheWarmStop).toHaveBeenCalledWith("agent-1", {
        at: new Date(START + 4 * MINUTE).toISOString(),
        reason: "quota",
        account: "u***a@example.com",
        window: "5h",
        until: "2026-10-27T14:00:00.000Z",
      });
    });

    it("skips the warm-up when the Gateway already moved the session to another account", async () => {
      const moved: WarmUpAccountBlock = { reason: "moved", account: "n***u@example.com" };
      const { manager, sendPrompt, setCacheWarmPause, recordCacheWarmStop } = createHarness({
        ttl: "5m",
        readAccountBlock: answersAccountBlock(moved),
      });
      manager.schedule("agent-1");

      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(setCacheWarmPause).toHaveBeenLastCalledWith("agent-1", moved);
      expect(stopReasons(recordCacheWarmStop)).toEqual(["moved"]);
    });

    it("sends nothing when the check throws, and reads again while the cache is still warm", async () => {
      const readAccountBlock = vi.fn(failsAccountCheck);
      const { manager, sendPrompt, setCacheWarmPause, recordCacheWarmStop } = createHarness({
        ttl: "5m",
        readAccountBlock,
      });
      manager.schedule("agent-1");

      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(setCacheWarmPause).toHaveBeenLastCalledWith("agent-1", {
        reason: "unconfirmed",
        account: "",
        retryAt: new Date(START + 4 * MINUTE + WARM_UP_ACCOUNT_RETRY_MS).toISOString(),
      });
      // Not given up yet, so nothing is journaled.
      expect(recordCacheWarmStop).not.toHaveBeenCalled();

      // The Gateway answers on the retry: the warm-up goes out and the pause clears.
      readAccountBlock.mockImplementation(answersAccountBlock(null));
      await vi.advanceTimersByTimeAsync(WARM_UP_ACCOUNT_RETRY_MS);
      expect(readAccountBlock).toHaveBeenCalledTimes(2);
      expect(sentPrompts(sendPrompt)).toEqual([DEFAULT_CACHE_WARM_PING_PROMPT]);
      expect(setCacheWarmPause).toHaveBeenLastCalledWith("agent-1", null);
    });

    it("lets the cache expire when the Gateway never answers before it would", async () => {
      const readAccountBlock = vi.fn(failsAccountCheck);
      const { manager, sendPrompt, setCacheWarmPause, recordCacheWarmStop } = createHarness({
        ttl: "5m",
        readAccountBlock,
      });
      manager.schedule("agent-1");

      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      // 4:00 and 4:20 leave time for another read; 4:40 does not.
      expect(readAccountBlock).toHaveBeenCalledTimes(3);
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(setCacheWarmPause).toHaveBeenLastCalledWith("agent-1", {
        reason: "unconfirmed",
        account: "",
      });
      expect(stopReasons(recordCacheWarmStop)).toEqual(["unconfirmed"]);
    });

    it("keeps a pause the agent record carried across a restart", () => {
      const { manager, agent } = createHarness({ ttl: "5m" });
      agent.cacheWarmPause = { reason: "cooldown", account: "u***a@example.com" };
      expect(manager.schedule("agent-1")).toBe(false);
    });

    it("sends nothing when a turn starts while the check is in flight", async () => {
      let agentRef: ManagedAgent | null = null;
      const { manager, agent, sendPrompt } = createHarness({
        ttl: "5m",
        readAccountBlock: async () => {
          // The user's message lands while the Gateway answers.
          if (agentRef) agentRef.lifecycle = "running";
          return null;
        },
      });
      agentRef = agent;
      manager.schedule("agent-1");

      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      expect(sendPrompt).not.toHaveBeenCalled();
    });
  });

  describe("why the warm-up left the cache to expire", () => {
    it("journals the idle cap once for the stretch, while the cache is still warm", async () => {
      const { manager, recordCacheWarmStop } = createHarness({ ttl: "5m", maxPings: 1 });
      manager.schedule("agent-1");

      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      // The warm-up's own request re-arms the manager, which now stands at the cap.
      expect(manager.schedule("agent-1")).toBe(false);
      manager.schedule("agent-1");
      expect(stopReasons(recordCacheWarmStop)).toEqual(["capped"]);
    });

    it("journals a warm-up that did not reach Anthropic", async () => {
      const { manager, sendPrompt, recordCacheWarmStop } = createHarness({ ttl: "5m" });
      sendPrompt.mockResolvedValueOnce({ disposition: "skipped" as never });
      manager.schedule("agent-1");

      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      expect(stopReasons(recordCacheWarmStop)).toEqual(["failed"]);
    });

    it("journals warm-up switched off while the cache is warm, but not after it expired", () => {
      const warm = createHarness({ ttl: "5m" });
      warm.manager.onFeatureToggled("agent-1", false);
      expect(stopReasons(warm.recordCacheWarmStop)).toEqual(["off"]);

      const expired = createHarness({ ttl: "5m", requestAtMs: START - 6 * MINUTE });
      expired.manager.onFeatureToggled("agent-1", false);
      expect(expired.recordCacheWarmStop).not.toHaveBeenCalled();
    });
  });

  it("never warms an Automatic cache window, even when warm-up was switched on", () => {
    const { manager } = createHarness({ ttl: "default", cacheWarm: true });
    expect(manager.schedule("agent-1")).toBe(false);
  });

  it("warms a 5m window by default, 4m after the last request", async () => {
    const { manager, sendPrompt } = createHarness({ ttl: "5m" });
    expect(manager.schedule("agent-1")).toBe(true);

    await vi.advanceTimersByTimeAsync(4 * MINUTE - 1000);
    expect(sendPrompt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: DEFAULT_CACHE_WARM_PING_PROMPT,
        replaceRunning: false,
        runOptions: { isWarmPing: true, lowestWarmUpEffort: true },
      }),
    );
  });

  it("anchors on the last request start, not on when the turn finished streaming", async () => {
    vi.setSystemTime(START + 3 * MINUTE);
    const { manager, sendPrompt } = createHarness({
      ttl: "1h",
      cacheWarm: true,
      requestAtMs: START,
      lastResponseAtMs: START + 3 * MINUTE,
    });
    manager.schedule("agent-1");

    await vi.advanceTimersByTimeAsync(55 * MINUTE - 1000);
    expect(sendPrompt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(START + 58 * MINUTE);
  });

  it("keeps warming an agent whose last turn ended in an error", async () => {
    const { manager, sendPrompt } = createHarness({ ttl: "5m", lifecycle: "error" });
    manager.schedule("agent-1");
    await vi.advanceTimersByTimeAsync(4.5 * MINUTE);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("stops after a failed warm-up instead of retrying, and re-arms on the next request", async () => {
    const { manager, agent, sendPrompt } = createHarness({ ttl: "1h", cacheWarm: true });
    sendPrompt.mockRejectedValueOnce(new Error("connection reset"));
    manager.schedule("agent-1");

    await vi.advanceTimersByTimeAsync(58 * MINUTE);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(manager.getConsecutivePings("agent-1")).toBe(0);
    expect(agent.totalWarmPings).toBeUndefined();
    expect(manager.schedule("agent-1")).toBe(false);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sendPrompt).toHaveBeenCalledTimes(1);

    agent.promptCache = promptCacheAt(Date.now());
    expect(manager.schedule("agent-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(58 * MINUTE);
    expect(sendPrompt).toHaveBeenCalledTimes(2);
  });

  it("does not count a warm-up the agent skipped because it was busy", async () => {
    const { manager, sendPrompt } = createHarness({ ttl: "1h", cacheWarm: true });
    sendPrompt.mockResolvedValueOnce({ disposition: "skipped" as never });
    manager.schedule("agent-1");
    await vi.advanceTimersByTimeAsync(58 * MINUTE);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(manager.getConsecutivePings("agent-1")).toBe(0);
  });

  it("caps a 1h idle stretch at 12 warm-ups and a 5m stretch at 10", async () => {
    const hour = createHarness({ ttl: "1h", cacheWarm: true });
    hour.manager.schedule("agent-1");
    for (let ping = 0; ping < 14; ping += 1) {
      await vi.advanceTimersByTimeAsync(58 * MINUTE);
      hour.manager.schedule("agent-1");
    }
    expect(hour.sendPrompt).toHaveBeenCalledTimes(12);

    vi.setSystemTime(START);
    const five = createHarness({ ttl: "5m" });
    five.manager.schedule("agent-1");
    for (let ping = 0; ping < 12; ping += 1) {
      await vi.advanceTimersByTimeAsync(4.5 * MINUTE);
      five.manager.schedule("agent-1");
    }
    expect(five.sendPrompt).toHaveBeenCalledTimes(10);
  });

  it("sends a ping turn under v1 even when the session can fork, and forks under v2", async () => {
    let fork = false;
    const harness = createHarness({ ttl: "5m", forkWarm: true, warmsThroughFork: () => fork });
    harness.manager.schedule("agent-1");
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(sentPrompts(harness.sendPrompt)).toEqual([DEFAULT_CACHE_WARM_PING_PROMPT]);
    expect(harness.warmPromptCache).not.toHaveBeenCalled();

    fork = true;
    harness.manager.schedule("agent-1");
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(harness.warmPromptCache).toHaveBeenCalledTimes(1);
    expect(harness.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("keeps warming past the cap while a child can still report, then stops at the cap", async () => {
    let childCanReport = true;
    const harness = createHarness({
      ttl: "5m",
      forkWarm: true,
      warmsPastCap: () => childCanReport,
    });
    harness.manager.schedule("agent-1");
    await vi.advanceTimersByTimeAsync(15 * 4 * MINUTE);
    expect(harness.warmPromptCache).toHaveBeenCalledTimes(15);

    // The child reported, so the stretch is past its cap and the cache is left to expire.
    childCanReport = false;
    await vi.advanceTimersByTimeAsync(3 * 4 * MINUTE);
    expect(harness.warmPromptCache).toHaveBeenCalledTimes(15);
  });

  describe("compacting at the idle cap", () => {
    function isPingPrompt(prompt: string): boolean {
      return prompt === DEFAULT_CACHE_WARM_PING_PROMPT;
    }

    async function runToCap(harness: ReturnType<typeof createHarness>): Promise<void> {
      harness.manager.schedule("agent-1");
      for (let ping = 0; ping < 12; ping += 1) {
        await vi.advanceTimersByTimeAsync(4.5 * MINUTE);
        harness.manager.schedule("agent-1");
      }
    }

    it("compacts a large context while the cache is still warm, then pauses warm-up", async () => {
      const harness = createHarness({ ttl: "5m", autoCompact: true, contextTokens: 250_000 });
      await runToCap(harness);
      // Long after the compaction: the compacted context still reads 250k, yet nothing is sent.
      for (let tick = 0; tick < 3; tick += 1) {
        await vi.advanceTimersByTimeAsync(4.5 * MINUTE);
        harness.manager.schedule("agent-1");
      }

      const prompts = sentPrompts(harness.sendPrompt);
      expect(prompts.filter(isPingPrompt)).toHaveLength(10);
      expect(prompts.slice(10)).toEqual(["/compact"]);
      // The compaction summarises the context, so it keeps the agent's own effort.
      expect(harness.sendPrompt).toHaveBeenLastCalledWith(
        expect.objectContaining({ prompt: "/compact", runOptions: { isWarmPing: true } }),
      );
      // Paused, not off: the agent keeps warm-up on and the count stays at the cap.
      expect(harness.setAgentFeature).not.toHaveBeenCalled();
      expect(harness.manager.getConsecutivePings("agent-1")).toBe(10);
      // The compaction is no warm-up: the lifetime total stays at the ten pings.
      expect(harness.agent.totalWarmPings).toBe(10);
    });

    it("resumes warm-up on the agent's next message after the idle-cap compaction", async () => {
      const harness = createHarness({ ttl: "5m", autoCompact: true, contextTokens: 250_000 });
      await runToCap(harness);
      expect(harness.manager.schedule("agent-1")).toBe(false);

      harness.manager.onTurnStarted("agent-1");
      harness.agent.promptCache = promptCacheAt(Date.now(), 60_000);
      harness.manager.onRequestRecorded("agent-1");
      expect(harness.manager.getConsecutivePings("agent-1")).toBe(0);
      await vi.advanceTimersByTimeAsync(4.5 * MINUTE);

      expect(sentPrompts(harness.sendPrompt).slice(11)).toEqual([DEFAULT_CACHE_WARM_PING_PROMPT]);
    });

    it("stays paused across a restart while the idle-cap compaction is the latest thing", async () => {
      const harness = createHarness({ ttl: "5m", autoCompact: true, contextTokens: 250_000 });
      const compactedAt = new Date(START + MINUTE).toISOString();
      harness.agent.promptCache = {
        ...promptCacheAt(START + MINUTE, 40_000),
        lastActivityAt: new Date(START).toISOString(),
        compactions: [{ at: compactedAt, trigger: "manual", atIdleCap: true }],
      };
      expect(harness.manager.schedule("agent-1")).toBe(false);

      harness.agent.promptCache = {
        ...harness.agent.promptCache,
        lastActivityAt: new Date(START + 2 * MINUTE).toISOString(),
      };
      expect(harness.manager.schedule("agent-1")).toBe(true);
    });

    it("lets a context under 200k tokens expire, because compacting it saves little", async () => {
      const harness = createHarness({ ttl: "5m", autoCompact: true, contextTokens: 150_000 });
      await runToCap(harness);
      expect(harness.sendPrompt).toHaveBeenCalledTimes(10);
      expect(harness.setAgentFeature).not.toHaveBeenCalled();
    });

    it("pauses the agent's schedules before the compaction is sent", async () => {
      const pause = vi.fn<(agentId: string) => Promise<void>>();
      const harness = createHarness({
        ttl: "5m",
        autoCompact: true,
        contextTokens: 250_000,
        onIdleCapCompaction: pause,
      });
      await runToCap(harness);

      const compactIndex = sentPrompts(harness.sendPrompt).indexOf("/compact");
      expect(compactIndex).toBeGreaterThan(-1);
      expect(pause).toHaveBeenCalledWith("agent-1");
      const compactCalledAt = harness.sendPrompt.mock.invocationCallOrder[compactIndex] ?? Infinity;
      expect(pause.mock.invocationCallOrder[0]).toBeLessThan(compactCalledAt);
    });

    it("does not compact when the schedules cannot be paused", async () => {
      const harness = createHarness({
        ttl: "5m",
        autoCompact: true,
        contextTokens: 250_000,
        onIdleCapCompaction: async () => {
          throw new Error("schedule store offline");
        },
      });
      await runToCap(harness);

      expect(sentPrompts(harness.sendPrompt)).not.toContain("/compact");
      expect(harness.setAgentFeature).not.toHaveBeenCalled();
    });

    it("follows the host default unless the agent says otherwise", async () => {
      const byDefault = createHarness({
        ttl: "5m",
        autoCompactByDefault: true,
        contextTokens: 250_000,
      });
      await runToCap(byDefault);
      expect(byDefault.sendPrompt).toHaveBeenCalledTimes(11);

      vi.setSystemTime(START);
      const optedOut = createHarness({
        ttl: "5m",
        autoCompact: false,
        autoCompactByDefault: true,
        contextTokens: 250_000,
      });
      await runToCap(optedOut);
      expect(optedOut.sendPrompt).toHaveBeenCalledTimes(10);
    });
  });

  it("stops at the agent's own cap, and never past the window's maximum", async () => {
    async function pingsSent(maxPings: unknown): Promise<number> {
      vi.setSystemTime(START);
      const { manager, sendPrompt } = createHarness({ ttl: "5m", maxPings });
      manager.schedule("agent-1");
      for (let ping = 0; ping < 14; ping += 1) {
        await vi.advanceTimersByTimeAsync(4.5 * MINUTE);
        manager.schedule("agent-1");
      }
      return sendPrompt.mock.calls.length;
    }
    expect(await pingsSent(3)).toBe(3);
    expect(await pingsSent(12)).toBe(10);
    expect(await pingsSent("lots")).toBe(10);
  });

  it("starts the cap again when the user sends a real prompt, keeping the lifetime total", async () => {
    const { manager, agent, sendPrompt } = createHarness({ ttl: "5m" });
    manager.schedule("agent-1");
    for (let ping = 0; ping < 10; ping += 1) {
      await vi.advanceTimersByTimeAsync(4.5 * MINUTE);
      manager.schedule("agent-1");
    }
    expect(manager.schedule("agent-1")).toBe(false);

    manager.onTurnStarted("agent-1");
    expect(manager.getConsecutivePings("agent-1")).toBe(0);
    expect(agent.totalWarmPings).toBe(10);
    expect(manager.schedule("agent-1")).toBe(true);
    expect(sendPrompt).toHaveBeenCalledTimes(10);
  });

  it("pauses a main agent's unanswered question at the warm-up deadline", async () => {
    const { manager, agent, sendPrompt, respondToPermission } = createHarness({
      ttl: "1h",
      cacheWarm: true,
      lifecycle: "running",
      pending: [{ id: "q-1", kind: "question", name: "AskUserQuestion" }],
    });
    expect(manager.schedule("agent-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(58 * MINUTE);
    expect(respondToPermission).toHaveBeenCalledWith("agent-1", "q-1", {
      behavior: "deny",
      message: CACHE_WARM_QUESTION_PAUSE_MESSAGE,
    });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(agent.promptCache?.questionClosedAt).toBe(new Date(START + 58 * MINUTE).toISOString());
  });

  it("tells the model the user is away and the question can be asked again, with no warm-up wording", () => {
    expect(CACHE_WARM_QUESTION_PAUSE_MESSAGE).not.toMatch(/cache|warm|ping|keep.{0,12}alive/i);
    expect(CACHE_WARM_QUESTION_PAUSE_MESSAGE).toContain("AFK");
    expect(CACHE_WARM_QUESTION_PAUSE_MESSAGE).toContain("couldn't answer this question");
    expect(CACHE_WARM_QUESTION_PAUSE_MESSAGE).toContain("ask the question again");
  });

  it("never dismisses a child agent's question, because its parent answers it", async () => {
    const { manager, respondToPermission } = createHarness({
      ttl: "5m",
      delegated: true,
      lifecycle: "running",
      pending: [{ id: "q-1", kind: "question", name: "AskUserQuestion" }],
    });
    expect(manager.schedule("agent-1")).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(respondToPermission).not.toHaveBeenCalled();
  });

  it("closes a main agent's pending permission at the warm-up deadline and records the command", async () => {
    const { manager, agent, sendPrompt, respondToPermission } = createHarness({
      ttl: "5m",
      cacheWarm: true,
      lifecycle: "running",
      pending: [
        {
          id: "p-1",
          kind: "tool",
          name: "Bash",
          title: "Run git push",
          input: { command: "git push --force-with-lease", description: "Push the branch" },
        },
      ],
    });
    expect(manager.schedule("agent-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(respondToPermission).toHaveBeenCalledWith("agent-1", "p-1", {
      behavior: "deny",
      message: CACHE_WARM_PERMISSION_PAUSE_MESSAGE,
    });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(agent.promptCache?.permissionClosed).toEqual({
      at: new Date(START + 4 * MINUTE).toISOString(),
      tool: "Bash",
      command: "git push --force-with-lease",
    });
    expect(agent.promptCache?.questionClosedAt).toBeUndefined();
  });

  it("tells the model the user could not approve, without warm-up wording", () => {
    expect(CACHE_WARM_PERMISSION_PAUSE_MESSAGE).not.toMatch(/cache|warm|ping|keep.{0,12}alive/i);
    expect(CACHE_WARM_PERMISSION_PAUSE_MESSAGE).toContain("AFK");
    expect(CACHE_WARM_PERMISSION_PAUSE_MESSAGE).toContain("don't try another way");
  });

  it("keeps a pending permission open when warm-up goes through a fork", async () => {
    const { manager, respondToPermission, warmPromptCache } = createHarness({
      ttl: "5m",
      forkWarm: true,
      lifecycle: "running",
      hasInFlightRun: true,
      pending: [{ id: "p-1", kind: "tool", name: "Bash", input: { command: "rm -rf build" } }],
    });
    expect(manager.schedule("agent-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(warmPromptCache).toHaveBeenCalledTimes(1);
    expect(respondToPermission).not.toHaveBeenCalled();
  });

  it("never closes a child agent's permission, because its parent answers it", async () => {
    const { manager, respondToPermission } = createHarness({
      ttl: "5m",
      delegated: true,
      lifecycle: "running",
      pending: [{ id: "p-1", kind: "tool", name: "Bash", input: { command: "ls" } }],
    });
    expect(manager.schedule("agent-1")).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(respondToPermission).not.toHaveBeenCalled();
  });

  it("waits on busy turns, expired caches and non-Claude models", () => {
    expect(createHarness({ ttl: "5m", lifecycle: "running" }).manager.schedule("agent-1")).toBe(
      false,
    );
    expect(createHarness({ ttl: "5m", hasInFlightRun: true }).manager.schedule("agent-1")).toBe(
      false,
    );
    expect(
      createHarness({ ttl: "5m", requestAtMs: START - 5 * MINUTE }).manager.schedule("agent-1"),
    ).toBe(false);
    expect(createHarness({ ttl: "5m", requestAtMs: null }).manager.schedule("agent-1")).toBe(false);
    expect(createHarness({ ttl: "5m", model: "gpt-6-luna" }).manager.schedule("agent-1")).toBe(
      false,
    );
  });

  it("times warm-up on the TTL the process writes, not a Cache window it has not relaunched with", async () => {
    const { manager, sendPrompt } = createHarness({
      ttl: "1h",
      cacheWarm: true,
      observedTtl: "5m",
    });
    expect(manager.schedule("agent-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(4.5 * MINUTE);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("sends nothing after a turn whose last request is older than the observed window", () => {
    vi.setSystemTime(START + 6 * MINUTE);
    const { manager, sendPrompt } = createHarness({
      ttl: "1h",
      cacheWarm: true,
      observedTtl: "5m",
    });
    expect(manager.schedule("agent-1")).toBe(false);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("falls back to the turn end for records written before request samples existed", async () => {
    const { manager, sendPrompt } = createHarness({
      ttl: "1h",
      cacheWarm: true,
      requestAtMs: null,
      lastResponseAtMs: START,
    });
    expect(manager.schedule("agent-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(58 * MINUTE);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("re-arms when warm-up is switched on and stops when it is switched off", () => {
    const { manager, agent } = createHarness({ ttl: "1h", cacheWarm: false });
    expect(manager.schedule("agent-1")).toBe(false);

    agent.config.featureValues = { ...agent.config.featureValues, cache_warm: true };
    manager.onFeatureToggled("agent-1", true);
    expect(manager.getPending("agent-1")).not.toBeNull();

    agent.config.featureValues = { ...agent.config.featureValues, cache_warm: false };
    manager.onFeatureToggled("agent-1", false);
    expect(manager.getPending("agent-1")).toBeNull();
  });
});

describe("AgentCacheWarmManager after a daemon restart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function storedRecord(overrides: Partial<StoredAgentRecord>): StoredAgentRecord {
    return {
      id: "dormant-1",
      provider: "claude",
      cwd: "/test",
      createdAt: new Date(START).toISOString(),
      updatedAt: new Date(START).toISOString(),
      labels: {},
      lastStatus: "closed",
      config: { featureValues: { prompt_cache_ttl: "1h", cache_warm: true } },
      promptCache: promptCacheAt(START - 10 * MINUTE),
      ...overrides,
    } as StoredAgentRecord;
  }

  async function bootstrapWith(records: StoredAgentRecord[]) {
    const sendPrompt = vi.fn(async () => ({ disposition: "turn_started" as const }));
    const loadAgent = vi.fn(async () => undefined);
    const warmPromptCache = vi.fn(async () => true);
    const manager = new AgentCacheWarmManager({
      agentManager: {
        getAgent: () => null,
        listAgents: () => [],
        hasInFlightRun: () => false,
        setCacheWarmCounts: () => undefined,
        recordCacheWarmStop: () => undefined,
        warmPromptCache,
      } as unknown as AgentManager,
      agentStorage: { list: async () => records } as unknown as AgentStorage,
      logger: pino({ level: "silent" }),
      sendPrompt,
      loadAgent,
    });
    await manager.bootstrap();
    return { manager, sendPrompt, loadAgent, warmPromptCache };
  }

  it("warms an idle agent that exists only on disk through a fork, after loading it", async () => {
    const { sendPrompt, loadAgent, warmPromptCache } = await bootstrapWith([storedRecord({})]);
    await vi.advanceTimersByTimeAsync(48 * MINUTE - 1000);
    expect(warmPromptCache).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(loadAgent).toHaveBeenCalledWith("dormant-1");
    expect(warmPromptCache).toHaveBeenCalledWith("dormant-1");
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("leaves archived, crashed-while-running and Automatic records alone", async () => {
    const { manager } = await bootstrapWith([
      storedRecord({ id: "archived", archivedAt: new Date(START).toISOString() }),
      storedRecord({ id: "running", lastStatus: "running" }),
      storedRecord({ id: "automatic", config: { featureValues: { cache_warm: true } } }),
    ]);
    expect(manager.getPending("archived")).toBeNull();
    expect(manager.getPending("running")).toBeNull();
    expect(manager.getPending("automatic")).toBeNull();
  });
});

describe("AgentCacheWarmManager with a real AgentManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  class TestClaudeSession {
    readonly provider = "claude" as const;
    readonly capabilities = {
      supportsStreaming: false,
      supportsSessionPersistence: false,
      supportsSessionListing: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    };
    readonly id = "sess-1";
    readonly prompts: string[] = [];
    private subscribers = new Set<(event: AgentStreamEvent) => void>();

    async run() {
      return { sessionId: this.id, finalText: "ok", timeline: [] };
    }

    emit(event: AgentStreamEvent) {
      for (const callback of this.subscribers) callback(event);
    }

    /** One API request, then the answer streams for `answerMs` before the turn completes. */
    playTurn(turnId: string, answerMs: number) {
      setTimeout(() => {
        this.emit({ type: "turn_started", provider: this.provider, turnId });
        this.emit({
          type: "usage_updated",
          provider: this.provider,
          usage: { requestCache: { readTokens: 1000, writeTokens: 5, uncachedTokens: 1 } },
        });
      }, 0);
      setTimeout(() => {
        this.emit({ type: "timeline", item: { type: "assistant_message", text: "done" } });
        this.emit({ type: "turn_completed", provider: this.provider, turnId });
      }, answerMs);
    }

    async startTurn(prompt: string) {
      this.prompts.push(prompt);
      const turnId = `turn-${this.prompts.length}`;
      // The first answer streams for two minutes; a warm-up reply is instant, so its turn can
      // finish before sendPromptToAgent resolves.
      this.playTurn(turnId, this.prompts.length === 1 ? 2 * MINUTE : 0);
      return { turnId };
    }

    subscribe(callback: (event: AgentStreamEvent) => void) {
      this.subscribers.add(callback);
      return () => {
        this.subscribers.delete(callback);
      };
    }

    describePersistence(): AgentPersistenceHandle {
      return { provider: "claude", sessionId: "sess-1" };
    }
  }

  async function createManagerHarness() {
    const logger = pino({ level: "silent" });
    const workdir = mkdtempSync(join(tmpdir(), "agent-warm-integ-"));
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    const session = new TestClaudeSession();
    const agentManager = new AgentManager({
      clients: {
        claude: {
          isAvailable: vi.fn().mockResolvedValue(true),
          capabilities: session.capabilities,
          createSession: vi.fn(async () => session),
          resumeSession: vi.fn(),
        } as unknown as import("./agent-sdk-types.js").AgentClient,
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000123",
    });
    const warmManager = new AgentCacheWarmManager({ agentManager, agentStorage: storage, logger });
    agentManager.setCacheWarmManager(warmManager);
    const snapshot = await agentManager.createAgent(
      {
        provider: "claude",
        cwd: workdir,
        featureValues: { prompt_cache_ttl: "1h", cache_warm: true },
      },
      undefined,
      { workspaceId: undefined },
    );
    const cleanup = async () => {
      await agentManager.flush();
      rmSync(workdir, { recursive: true, force: true });
    };
    return { agentManager, warmManager, storage, session, agentId: snapshot.id, cleanup };
  }

  it("pings 58 minutes after the last request and publishes the warm-up counts", async () => {
    const { agentManager, warmManager, storage, session, agentId, cleanup } =
      await createManagerHarness();
    try {
      const run = agentManager.runAgent(agentId, "do the work");
      await vi.advanceTimersByTimeAsync(2 * MINUTE + 1);
      await run;
      expect(agentManager.getAgent(agentId)?.lifecycle).toBe("idle");
      expect(warmManager.getPending(agentId)?.scheduledFor.getTime()).toBe(START + 58 * MINUTE);

      await vi.advanceTimersByTimeAsync(56 * MINUTE - 2);
      expect(session.prompts).toEqual(["do the work"]);
      await vi.advanceTimersByTimeAsync(2);
      expect(session.prompts).toEqual(["do the work", DEFAULT_CACHE_WARM_PING_PROMPT]);

      await vi.advanceTimersByTimeAsync(10);
      await agentManager.flush();
      expect(agentManager.getAgent(agentId)).toMatchObject({
        consecutiveWarmPings: 1,
        totalWarmPings: 1,
      });
      expect(await storage.get(agentId)).toMatchObject({
        consecutiveWarmPings: 1,
        totalWarmPings: 1,
      });
    } finally {
      await cleanup();
    }
  });

  it("re-arms after a turn the agent started on its own, such as a task notification", async () => {
    const { agentManager, warmManager, session, agentId, cleanup } = await createManagerHarness();
    try {
      session.playTurn("autonomous-1", MINUTE);
      await vi.advanceTimersByTimeAsync(MINUTE + 1);
      await agentManager.flush();
      expect(agentManager.getAgent(agentId)?.lifecycle).toBe("idle");
      expect(agentManager.hasInFlightRun(agentId)).toBe(false);
      expect(warmManager.getPending(agentId)?.scheduledFor.getTime()).toBe(START + 58 * MINUTE);
    } finally {
      await cleanup();
    }
  });
});
