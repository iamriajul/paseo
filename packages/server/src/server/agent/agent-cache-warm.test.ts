import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPromptCacheState } from "@getpaseo/protocol/agent-cache-warm";
import {
  AgentCacheWarmManager,
  CACHE_WARM_QUESTION_PAUSE_MESSAGE,
  DEFAULT_CACHE_WARM_PING_PROMPT,
} from "./agent-cache-warm.js";
import { AgentStorage, type StoredAgentRecord } from "./agent-storage.js";
import { AgentManager, type ManagedAgent } from "./agent-manager.js";
import type { AgentPersistenceHandle, AgentStreamEvent } from "./agent-sdk-types.js";

const MINUTE = 60 * 1000;
const START = new Date("2026-10-27T10:00:00.000Z").getTime();

function promptCacheAt(atMs: number): AgentPromptCacheState {
  const sample = {
    at: new Date(atMs).toISOString(),
    turnId: "turn-1",
    isWarmPing: false,
    readTokens: 1000,
    writeTokens: 10,
    uncachedTokens: 1,
  };
  return { lastRequest: sample, turnFirstRequest: sample };
}

interface HarnessOptions {
  ttl?: "5m" | "1h" | "default";
  cacheWarm?: boolean;
  lifecycle?: ManagedAgent["lifecycle"];
  model?: string;
  delegated?: boolean;
  pending?: Array<{ id: string; kind?: string; name?: string }>;
  hasInFlightRun?: boolean;
  requestAtMs?: number | null;
  lastResponseAtMs?: number | null;
  observedTtl?: "5m" | "1h";
}

function buildAgent(options: HarnessOptions): ManagedAgent {
  const featureValues: Record<string, unknown> = { prompt_cache_ttl: options.ttl ?? "1h" };
  if (options.cacheWarm !== undefined) {
    featureValues.cache_warm = options.cacheWarm;
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
        : { ...promptCacheAt(requestAtMs), observedTtl: options.observedTtl },
    labels: options.delegated ? { "paseo.parent-agent-id": "parent-1" } : {},
  } as unknown as ManagedAgent;
}

function createHarness(options: HarnessOptions = {}) {
  const agent = buildAgent(options);
  const sendPrompt = vi.fn(async () => {
    // A ping that reaches Anthropic produces a message_start, which moves the anchor.
    agent.promptCache = promptCacheAt(Date.now());
    return { disposition: "turn_started" as const };
  });
  const respondToPermission = vi.fn(async () => {
    agent.pendingPermissions.clear();
    agent.promptCache = promptCacheAt(Date.now());
  });
  const manager = new AgentCacheWarmManager({
    agentManager: {
      getAgent: (id: string) => (id === agent.id ? agent : null),
      hasInFlightRun: () => options.hasInFlightRun ?? false,
      respondToPermission,
      markQuestionClosed: () => {
        if (agent.promptCache) {
          agent.promptCache = { ...agent.promptCache, questionClosedAt: new Date().toISOString() };
        }
      },
      listAgents: () => [agent],
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
  });
  return { manager, agent, sendPrompt, respondToPermission };
}

describe("AgentCacheWarmManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never warms an Automatic cache window, even when warm-up was switched on", () => {
    const { manager } = createHarness({ ttl: "default", cacheWarm: true });
    expect(manager.schedule("agent-1")).toBe(false);
  });

  it("warms a 5m window by default, 4m30s after the last request", async () => {
    const { manager, sendPrompt } = createHarness({ ttl: "5m" });
    expect(manager.schedule("agent-1")).toBe(true);

    await vi.advanceTimersByTimeAsync(4.5 * MINUTE - 1000);
    expect(sendPrompt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: DEFAULT_CACHE_WARM_PING_PROMPT, replaceRunning: false }),
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

  it("waits on tool permissions, busy turns, expired caches and non-Claude models", () => {
    expect(createHarness({ ttl: "5m", pending: [{ id: "p-1" }] }).manager.schedule("agent-1")).toBe(
      false,
    );
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
    const manager = new AgentCacheWarmManager({
      agentManager: {
        getAgent: () => null,
        listAgents: () => [],
        hasInFlightRun: () => false,
        setCacheWarmCounts: () => undefined,
      } as unknown as AgentManager,
      agentStorage: { list: async () => records } as unknown as AgentStorage,
      logger: pino({ level: "silent" }),
      sendPrompt,
    });
    await manager.bootstrap();
    return { manager, sendPrompt };
  }

  it("warms an idle agent that exists only on disk, which loads it", async () => {
    const { sendPrompt } = await bootstrapWith([storedRecord({})]);
    await vi.advanceTimersByTimeAsync(48 * MINUTE - 1000);
    expect(sendPrompt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({ agentId: "dormant-1" }));
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
