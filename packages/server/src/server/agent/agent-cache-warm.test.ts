import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentCacheWarmManager,
  CACHE_WARM_QUESTION_PAUSE_MESSAGE,
  DEFAULT_CACHE_WARM_INTERVAL_MS,
  DEFAULT_CACHE_WARM_PING_PROMPT,
} from "./agent-cache-warm.js";
import { AgentStorage } from "./agent-storage.js";
import { CLAUDE_CACHE_WARM_FEATURE_ID } from "./providers/claude/feature-definitions.js";
import { AgentManager, type ManagedAgent } from "./agent-manager.js";

describe("AgentCacheWarmManager", () => {
  let logger: pino.Logger;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = pino({ level: "silent" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  interface HarnessOptions {
    featureEnabled?: boolean | "default";
    lifecycle?: "idle" | "running" | "closed";
    archived?: boolean;
    pendingPermissions?: number;
    pendingQuestions?: Array<{ id: string; kind?: string; name?: string }>;
    hasInFlightRun?: boolean;
    lastUserMessageAt?: Date | null;
    lastResponseAt?: Date | null;
    promptCacheTtl?: string;
    isSubagent?: boolean;
    intervalMs?: number;
  }

  function buildMockAgent(options: HarnessOptions = {}): ManagedAgent {
    const lifecycle = options.archived ? "closed" : (options.lifecycle ?? "idle");
    const lastResponseAt =
      options.lastResponseAt !== undefined
        ? options.lastResponseAt
        : (options.lastUserMessageAt ?? new Date());
    const pendingPermissions = new Map<string, unknown>();
    const count = options.pendingPermissions ?? 0;
    for (let i = 0; i < count; i++) {
      pendingPermissions.set(`perm-${i}`, { id: `perm-${i}` });
    }
    if (options.pendingQuestions) {
      for (const q of options.pendingQuestions) {
        pendingPermissions.set(q.id, q);
      }
    }

    const featureValues: Record<string, unknown> = {};
    if (options.promptCacheTtl) {
      featureValues.prompt_cache_ttl = options.promptCacheTtl;
    }
    if (options.featureEnabled !== "default") {
      featureValues[CLAUDE_CACHE_WARM_FEATURE_ID] = options.featureEnabled ?? true;
    }

    return {
      id: "agent-1",
      provider: "claude",
      cwd: "/test",
      config: {
        provider: "claude",
        cwd: "/test",
        featureValues,
      },
      lifecycle,
      pendingPermissions: pendingPermissions as unknown as ManagedAgent["pendingPermissions"],
      lastUserMessageAt: options.lastUserMessageAt ?? null,
      lastResponseAt,
      updatedAt: lastResponseAt,
      createdAt: lastResponseAt,
      capabilities: {} as unknown as ManagedAgent["capabilities"],
      availableModes: [],
      currentModeId: null,
      bufferedPermissionResolutions: new Map(),
      inFlightPermissionResponses: new Set(),
      pendingReplacement: false,
      persistence: null,
      historyPrimed: true,
      activeTurnId: null,
      activeTurnStartedAt: null,
      attention: {} as unknown as ManagedAgent["attention"],
      foregroundTurnWaiters: new Set(),
      finalizedForegroundTurnIds: new Set(),
      unsubscribeSession: null,
      labels: options.isSubagent ? { "paseo.parent-agent-id": "parent-1" } : {},
    } as unknown as ManagedAgent;
  }

  function createHarness(options: HarnessOptions = {}) {
    const mockAgent = buildMockAgent(options);
    const inFlightRun = options.hasInFlightRun ?? false;

    const getAgent = vi.fn().mockImplementation((id: string) => {
      if (id === "agent-1") return mockAgent;
      return null;
    });
    const hasInFlightRun = vi.fn().mockImplementation(() => inFlightRun);
    const sendPrompt = vi.fn().mockResolvedValue({ disposition: "turn_started" });
    const respondToPermission = vi.fn().mockResolvedValue(undefined);

    const manager = new AgentCacheWarmManager({
      agentManager: {
        getAgent,
        hasInFlightRun,
        respondToPermission,
      } as unknown as import("./agent-manager.js").AgentManager,
      agentStorage: {} as unknown as AgentStorage,
      logger,
      sendPrompt,
      intervalMs: options.intervalMs,
    });

    return { manager, mockAgent, getAgent, hasInFlightRun, sendPrompt, respondToPermission };
  }

  it("does not schedule if cache_warm feature is disabled", () => {
    const { manager } = createHarness({ featureEnabled: false });
    const scheduled = manager.schedule("agent-1");
    expect(scheduled).toBe(false);
    expect(manager.hasPending("agent-1")).toBe(false);
  });

  it("does not schedule if agent is archived", () => {
    const { manager } = createHarness({ archived: true });
    const scheduled = manager.schedule("agent-1");
    expect(scheduled).toBe(false);
    expect(manager.hasPending("agent-1")).toBe(false);
  });

  it("does not schedule if agent is running", () => {
    const { manager } = createHarness({ lifecycle: "running", hasInFlightRun: true });
    const scheduled = manager.schedule("agent-1");
    expect(scheduled).toBe(false);
    expect(manager.hasPending("agent-1")).toBe(false);
  });

  it("does not schedule if agent has pending permissions", () => {
    const { manager } = createHarness({ pendingPermissions: 1 });
    const scheduled = manager.schedule("agent-1");
    expect(scheduled).toBe(false);
    expect(manager.hasPending("agent-1")).toBe(false);
  });

  it("schedules cache warm timer when agent is awaiting answer on a question", () => {
    const { manager } = createHarness({
      lifecycle: "running",
      hasInFlightRun: true,
      pendingQuestions: [{ id: "q-1", kind: "question", name: "AskUserQuestion" }],
    });
    const scheduled = manager.schedule("agent-1");
    expect(scheduled).toBe(true);
    expect(manager.hasPending("agent-1")).toBe(true);
  });

  it("does not schedule if pending permissions include mixed question and non-question permissions", () => {
    const { manager } = createHarness({
      lifecycle: "running",
      pendingPermissions: 1, // regular tool permission (e.g. bash)
      pendingQuestions: [{ id: "q-1", kind: "question", name: "AskUserQuestion" }],
    });
    const scheduled = manager.schedule("agent-1");
    expect(scheduled).toBe(false);
    expect(manager.hasPending("agent-1")).toBe(false);
  });

  it("schedules and triggers ping after interval when idle", async () => {
    const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
    vi.setSystemTime(startTime);

    const { manager, sendPrompt } = createHarness({
      lastUserMessageAt: new Date(startTime),
    });

    const scheduled = manager.schedule("agent-1");
    expect(scheduled).toBe(true);
    expect(manager.hasPending("agent-1")).toBe(true);

    // Advance 57 minutes - should not fire yet
    await vi.advanceTimersByTimeAsync(57 * 60 * 1000);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(manager.hasPending("agent-1")).toBe(true);

    // Advance 1 more minute (total 58 minutes) - should fire
    await vi.advanceTimersByTimeAsync(1 * 60 * 1000);
    expect(sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        prompt: DEFAULT_CACHE_WARM_PING_PROMPT,
        unarchive: false,
      }),
    );
    expect(manager.hasPending("agent-1")).toBe(false);
  });

  it("reschedules timer when message activity occurs during idle wait", async () => {
    const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
    vi.setSystemTime(startTime);

    const { manager, sendPrompt } = createHarness({
      lastUserMessageAt: new Date(startTime),
    });

    manager.schedule("agent-1");

    // Advance 30 minutes
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(sendPrompt).not.toHaveBeenCalled();

    // User sends a message at minute 30
    const messageTime = new Date(Date.now());
    manager.onMessageActivity("agent-1", messageTime);

    // Advance 30 minutes from start (minute 60 total, only 30 mins since last message)
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(sendPrompt).not.toHaveBeenCalled();

    // Advance remaining 28 minutes (58 minutes since messageTime)
    await vi.advanceTimersByTimeAsync(28 * 60 * 1000);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("reschedules timer on turn completed", async () => {
    const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
    vi.setSystemTime(startTime);

    const { manager, sendPrompt } = createHarness();

    manager.onTurnCompleted("agent-1");
    expect(manager.hasPending("agent-1")).toBe(true);

    await vi.advanceTimersByTimeAsync(DEFAULT_CACHE_WARM_INTERVAL_MS);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("cancels timer when feature is toggled off", () => {
    const { manager, mockAgent } = createHarness();

    manager.schedule("agent-1");
    expect(manager.hasPending("agent-1")).toBe(true);

    (mockAgent.config.featureValues as Record<string, unknown>)[CLAUDE_CACHE_WARM_FEATURE_ID] =
      false;
    manager.onFeatureToggled("agent-1", false);
    expect(manager.hasPending("agent-1")).toBe(false);
  });

  it("schedules timer when feature is toggled on", () => {
    const { manager } = createHarness({ featureEnabled: true });

    manager.onFeatureToggled("agent-1", true);
    expect(manager.hasPending("agent-1")).toBe(true);
  });

  it("cancels all timers on cancelAll", () => {
    const { manager } = createHarness();

    manager.schedule("agent-1");
    expect(manager.hasPending("agent-1")).toBe(true);

    manager.cancelAll();
    expect(manager.hasPending("agent-1")).toBe(false);
  });

  it("skips ping if agent became busy before timer fired", async () => {
    const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
    vi.setSystemTime(startTime);

    const { manager, mockAgent, sendPrompt } = createHarness({
      lastUserMessageAt: new Date(startTime),
    });

    manager.schedule("agent-1");

    // Agent transitions to running before timer fires
    mockAgent.lifecycle = "running";

    await vi.advanceTimersByTimeAsync(DEFAULT_CACHE_WARM_INTERVAL_MS);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("triggers ping immediately if session was already idle past interval but cache still warm", async () => {
    const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
    vi.setSystemTime(startTime);

    // Last message was 59 minutes ago (past 58m interval, but within 60m cache window)
    const lastResponseAt = new Date(startTime - 59 * 60 * 1000);
    const { manager, sendPrompt } = createHarness({
      lastResponseAt,
      featureEnabled: true,
    });

    manager.onFeatureToggled("agent-1", true);
    expect(manager.hasPending("agent-1")).toBe(true);

    // Advance 0ms (next tick)
    await vi.advanceTimersByTimeAsync(1);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(manager.hasPending("agent-1")).toBe(false);
  });

  it("does not schedule or ping if cache has already expired when enabled", async () => {
    const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
    vi.setSystemTime(startTime);

    // Last message was 65 minutes ago (past 60m cache window)
    const lastResponseAt = new Date(startTime - 65 * 60 * 1000);
    const { manager, sendPrompt } = createHarness({
      lastResponseAt,
      featureEnabled: true,
    });

    manager.onFeatureToggled("agent-1", true);
    expect(manager.hasPending("agent-1")).toBe(false);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("refuses to schedule or ping for non-Claude models", () => {
    const { manager, mockAgent } = createHarness({
      featureEnabled: true,
    });
    mockAgent.config.model = "gemini-3.8-flash-high";

    expect(manager.isFeatureEnabled(mockAgent.id)).toBe(false);
    expect(manager.schedule(mockAgent.id)).toBe(false);
    expect(manager.hasPending(mockAgent.id)).toBe(false);
  });

  it("bootstraps and schedules timers for all enabled loaded agents", () => {
    const { manager, mockAgent } = createHarness({ featureEnabled: true });

    manager.bootstrap([mockAgent]);
    expect(manager.hasPending("agent-1")).toBe(true);
  });

  it("uses 4 minute interval for subagents with 5m cache window", async () => {
    const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
    vi.setSystemTime(startTime);

    const { manager, sendPrompt } = createHarness({
      isSubagent: true,
      lastResponseAt: new Date(startTime),
    });

    manager.schedule("agent-1");
    expect(manager.hasPending("agent-1")).toBe(true);

    // Advance 3 minutes - should not fire yet
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(sendPrompt).not.toHaveBeenCalled();

    // Advance 1 more minute (total 4 minutes for 5m cache window)
    await vi.advanceTimersByTimeAsync(1 * 60 * 1000);
    expect(sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        prompt: DEFAULT_CACHE_WARM_PING_PROMPT,
        replaceRunning: false,
        runOptions: {
          isWarmPing: true,
        },
      }),
    );
  });

  it("reschedules ping if sendPrompt returns disposition: skipped", async () => {
    const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
    vi.setSystemTime(startTime);

    const { manager, sendPrompt } = createHarness({
      featureEnabled: true,
      lastResponseAt: new Date(startTime),
    });
    sendPrompt.mockResolvedValueOnce({ disposition: "skipped" });

    manager.schedule("agent-1");
    expect(manager.hasPending("agent-1")).toBe(true);

    // Fire the timer
    await vi.advanceTimersByTimeAsync(DEFAULT_CACHE_WARM_INTERVAL_MS);
    expect(sendPrompt).toHaveBeenCalledTimes(1);

    // Should have rescheduled since it was skipped
    expect(manager.hasPending("agent-1")).toBe(true);
  });

  it("caps consecutive pings at 12 for 1-hour TTL sessions", async () => {
    const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
    vi.setSystemTime(startTime);

    const { manager, sendPrompt } = createHarness({
      featureEnabled: true,
      lastResponseAt: new Date(startTime),
    });

    manager.schedule("agent-1");

    // Advance through 12 pings
    for (let i = 1; i <= 12; i++) {
      expect(manager.hasPending("agent-1")).toBe(true);
      await vi.advanceTimersByTimeAsync(DEFAULT_CACHE_WARM_INTERVAL_MS);
      expect(sendPrompt).toHaveBeenCalledTimes(i);
      expect(manager.getConsecutivePings("agent-1")).toBe(i);
      manager.schedule("agent-1");
    }

    // 12 pings have completed: auto-cap reached!
    expect(manager.hasPending("agent-1")).toBe(false);

    // Advancing further does NOT fire ping 13
    await vi.advanceTimersByTimeAsync(DEFAULT_CACHE_WARM_INTERVAL_MS);
    expect(sendPrompt).toHaveBeenCalledTimes(12);

    // Activity resets the cap:
    manager.onMessageActivity("agent-1");
    expect(manager.getConsecutivePings("agent-1")).toBe(0);
    expect(manager.hasPending("agent-1")).toBe(true);
  });

  it("caps consecutive pings at 10 for 5-minute TTL subagents", async () => {
    const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
    vi.setSystemTime(startTime);

    const { manager, sendPrompt } = createHarness({
      isSubagent: true,
      featureEnabled: true,
      lastResponseAt: new Date(startTime),
    });

    manager.schedule("agent-1");

    // Advance through 10 pings (4 minutes each)
    for (let i = 1; i <= 10; i++) {
      expect(manager.hasPending("agent-1")).toBe(true);
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      expect(sendPrompt).toHaveBeenCalledTimes(i);
      expect(manager.getConsecutivePings("agent-1")).toBe(i);
      manager.schedule("agent-1");
    }

    // 10 pings completed: auto-cap reached!
    expect(manager.hasPending("agent-1")).toBe(false);

    // Advancing further does NOT fire ping 11
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(sendPrompt).toHaveBeenCalledTimes(10);
  });

  it("arms watchdog and dispatches ping after real turn completion in AgentManager", async () => {
    const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
    vi.setSystemTime(startTime);

    const workdir = mkdtempSync(join(tmpdir(), "agent-warm-integ-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    let streamTurnCount = 0;
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
      private subscribers = new Set<
        (event: import("./agent-sdk-types.js").AgentStreamEvent) => void
      >();

      async run() {
        return { sessionId: this.id, finalText: "ok", timeline: [] };
      }

      async startTurn() {
        const turnId = `turn-${++streamTurnCount}`;
        setTimeout(() => {
          for (const cb of this.subscribers) {
            cb({ type: "turn_started", provider: this.provider, turnId });
            cb({ type: "timeline", item: { type: "assistant_message", text: "ok" } });
            cb({ type: "turn_completed", provider: this.provider, turnId });
          }
        }, 0);
        return { turnId };
      }

      subscribe(callback: (event: import("./agent-sdk-types.js").AgentStreamEvent) => void) {
        this.subscribers.add(callback);
        return () => {
          this.subscribers.delete(callback);
        };
      }

      describePersistence(): import("./agent-sdk-types.js").AgentPersistenceHandle {
        return { provider: "claude", sessionId: "sess-1" };
      }
    }

    const fakeClient = {
      isAvailable: vi.fn().mockResolvedValue(true),
      capabilities: {
        supportsStreaming: false,
        supportsSessionPersistence: false,
        supportsSessionListing: true,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
      },
      createSession: vi.fn().mockImplementation(async () => new TestClaudeSession()),
      resumeSession: vi.fn(),
    };

    const agentManager = new AgentManager({
      clients: {
        claude: fakeClient as unknown as import("./agent-sdk-types.js").AgentClient,
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000123",
    });

    const warmManager = new AgentCacheWarmManager({
      agentManager,
      agentStorage: storage,
      logger,
    });
    agentManager.setCacheWarmManager(warmManager);

    // Create an agent with cache_warm: true
    const snapshot = await agentManager.createAgent(
      {
        provider: "claude",
        cwd: workdir,
        featureValues: {
          [CLAUDE_CACHE_WARM_FEATURE_ID]: true,
        },
      },
      undefined,
      { workspaceId: undefined },
    );

    // Run a turn through AgentManager
    const runPromise = agentManager.runAgent(snapshot.id, "User prompt asking to do work");
    await vi.advanceTimersByTimeAsync(1);
    await runPromise;
    await agentManager.flush();

    const live = agentManager.getAgent(snapshot.id);
    expect(live?.lifecycle).toBe("idle");
    expect(agentManager.hasInFlightRun(snapshot.id)).toBe(false);

    // Watchdog must be armed from turn completion!
    expect(warmManager.hasPending(snapshot.id)).toBe(true);

    // Advance 57 minutes: ping should not have fired yet
    await vi.advanceTimersByTimeAsync(57 * 60 * 1000);
    expect(streamTurnCount).toBe(1);

    // Advance 1 more minute (58 minutes total): ping fires automatically!
    await vi.advanceTimersByTimeAsync(1 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(1);
    expect(streamTurnCount).toBe(2);

    // Cleanup
    rmSync(workdir, { recursive: true, force: true });
  });

  it("does not schedule cache warming for a brand new agent with no prior interactions", () => {
    const { manager, mockAgent } = createHarness({
      featureEnabled: true,
      lastUserMessageAt: null,
      lastResponseAt: null,
    });

    expect(manager.schedule(mockAgent.id)).toBe(false);
    expect(manager.hasPending(mockAgent.id)).toBe(false);
  });

  it("reschedules gracefully when triggerPing encounters an unexpected exception", async () => {
    const { manager, mockAgent, sendPrompt } = createHarness({ featureEnabled: true });
    sendPrompt.mockRejectedValue(new Error("Transient connection error"));

    expect(manager.schedule(mockAgent.id)).toBe(true);
    expect(manager.hasPending(mockAgent.id)).toBe(true);

    // Fire timer
    await vi.advanceTimersByTimeAsync(58 * 60 * 1000);
    expect(sendPrompt).toHaveBeenCalledTimes(1);

    // Watchdog must reschedule rather than die!
    expect(manager.hasPending(mockAgent.id)).toBe(true);
  });

  it("bootstrap restores consecutiveWarmPings from loaded agents", () => {
    const { manager, mockAgent } = createHarness({ featureEnabled: true });
    mockAgent.consecutiveWarmPings = 5;

    manager.bootstrap([mockAgent]);
    expect(manager.getConsecutivePings(mockAgent.id)).toBe(5);
  });

  it("respects consecutiveWarmPings from lazily restored agents", () => {
    const { manager, mockAgent } = createHarness({ featureEnabled: true });
    mockAgent.consecutiveWarmPings = 12; // Capped

    // Map has no entry yet, but agent mirror is consulted
    expect(manager.getConsecutivePings(mockAgent.id)).toBe(12);
    expect(manager.schedule(mockAgent.id)).toBe(false);
    expect(manager.hasPending(mockAgent.id)).toBe(false);

    // Registering seeds the map
    manager.onAgentRegistered(mockAgent.id, 12);
    expect(manager.getConsecutivePings(mockAgent.id)).toBe(12);
  });

  it("cancelAll resets all mirrored agent ping counts and active timers", () => {
    const { manager, mockAgent } = createHarness({ featureEnabled: true });
    manager.schedule(mockAgent.id);
    manager.onAgentRegistered(mockAgent.id, 3);
    mockAgent.consecutiveWarmPings = 3;

    manager.cancelAll();
    expect(manager.hasPending(mockAgent.id)).toBe(false);
    expect(mockAgent.consecutiveWarmPings).toBe(0);
    expect(manager.getConsecutivePings(mockAgent.id)).toBe(0);
  });

  it("deleteAgent cleans up internal timestamps, epochs, and timers", () => {
    const { manager, mockAgent } = createHarness({ featureEnabled: true });

    manager.schedule(mockAgent.id);
    manager.onMessageActivity(mockAgent.id);
    expect(manager.hasPending(mockAgent.id)).toBe(true);

    manager.deleteAgent(mockAgent.id);
    expect(manager.hasPending(mockAgent.id)).toBe(false);
    expect(manager.getConsecutivePings(mockAgent.id)).toBe(0);
  });

  it("interrupts pending question with pause message when watchdog timer fires", async () => {
    const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
    vi.setSystemTime(startTime);

    const { manager, respondToPermission, sendPrompt } = createHarness({
      featureEnabled: true,
      lifecycle: "running",
      hasInFlightRun: true,
      lastResponseAt: new Date(startTime),
      pendingQuestions: [{ id: "q-1", kind: "question", name: "AskUserQuestion" }],
    });

    expect(manager.schedule("agent-1")).toBe(true);
    expect(manager.hasPending("agent-1")).toBe(true);

    // Advance 57 minutes: should not interrupt yet
    await vi.advanceTimersByTimeAsync(57 * 60 * 1000);
    expect(respondToPermission).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();

    // Advance 1 more minute (58 minutes total)
    await vi.advanceTimersByTimeAsync(1 * 60 * 1000);
    expect(respondToPermission).toHaveBeenCalledTimes(1);
    expect(respondToPermission).toHaveBeenCalledWith("agent-1", "q-1", {
      behavior: "deny",
      message: CACHE_WARM_QUESTION_PAUSE_MESSAGE,
    });
    // Claude naturally wraps up turn and refreshes KV cache on tool completion, no sendPrompt needed
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(manager.getConsecutivePings("agent-1")).toBe(1);
  });

  it("interrupts multiple pending questions when present", async () => {
    const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
    vi.setSystemTime(startTime);

    const { manager, respondToPermission, sendPrompt } = createHarness({
      featureEnabled: true,
      lifecycle: "running",
      hasInFlightRun: true,
      lastResponseAt: new Date(startTime),
      pendingQuestions: [
        { id: "q-1", kind: "question" },
        { id: "q-2", name: "AskUserQuestion" },
      ],
    });

    expect(manager.schedule("agent-1")).toBe(true);

    await vi.advanceTimersByTimeAsync(DEFAULT_CACHE_WARM_INTERVAL_MS);
    expect(respondToPermission).toHaveBeenCalledTimes(2);
    expect(respondToPermission).toHaveBeenCalledWith("agent-1", "q-1", {
      behavior: "deny",
      message: CACHE_WARM_QUESTION_PAUSE_MESSAGE,
    });
    expect(respondToPermission).toHaveBeenCalledWith("agent-1", "q-2", {
      behavior: "deny",
      message: CACHE_WARM_QUESTION_PAUSE_MESSAGE,
    });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(manager.getConsecutivePings("agent-1")).toBe(1);
  });

  it("interrupts question for subagent with 5-minute cache window after 4 minutes", async () => {
    const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
    vi.setSystemTime(startTime);

    const { manager, respondToPermission, sendPrompt } = createHarness({
      isSubagent: true,
      featureEnabled: true,
      lifecycle: "running",
      hasInFlightRun: true,
      lastResponseAt: new Date(startTime),
      pendingQuestions: [{ id: "q-sub", kind: "question" }],
    });

    expect(manager.schedule("agent-1")).toBe(true);

    // Advance 3 minutes - should not fire yet
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(respondToPermission).not.toHaveBeenCalled();

    // Advance 1 more minute (4 minutes total for 5m TTL subagents)
    await vi.advanceTimersByTimeAsync(1 * 60 * 1000);
    expect(respondToPermission).toHaveBeenCalledTimes(1);
    expect(respondToPermission).toHaveBeenCalledWith("agent-1", "q-sub", {
      behavior: "deny",
      message: CACHE_WARM_QUESTION_PAUSE_MESSAGE,
    });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(manager.getConsecutivePings("agent-1")).toBe(1);
  });

  it("reschedules watchdog if respondToPermission throws an error", async () => {
    const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
    vi.setSystemTime(startTime);

    const { manager, respondToPermission } = createHarness({
      featureEnabled: true,
      lifecycle: "running",
      hasInFlightRun: true,
      lastResponseAt: new Date(startTime),
      pendingQuestions: [{ id: "q-err", kind: "question" }],
    });
    respondToPermission.mockRejectedValueOnce(new Error("RPC timeout"));

    expect(manager.schedule("agent-1")).toBe(true);

    await vi.advanceTimersByTimeAsync(DEFAULT_CACHE_WARM_INTERVAL_MS);
    expect(respondToPermission).toHaveBeenCalledTimes(1);
    expect(manager.hasPending("agent-1")).toBe(true);
  });

  it("does not interrupt question if non-question permission arrived before timer fires", async () => {
    const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
    vi.setSystemTime(startTime);

    const { manager, mockAgent, respondToPermission } = createHarness({
      featureEnabled: true,
      lifecycle: "running",
      hasInFlightRun: true,
      lastResponseAt: new Date(startTime),
      pendingQuestions: [{ id: "q-1", kind: "question" }],
    });

    expect(manager.schedule("agent-1")).toBe(true);

    // A non-question permission request arrives while question is pending
    mockAgent.pendingPermissions.set("perm-bash", {
      id: "perm-bash",
    } as unknown as import("./agent-sdk-types.js").AgentPermissionRequest);

    await vi.advanceTimersByTimeAsync(DEFAULT_CACHE_WARM_INTERVAL_MS);
    expect(respondToPermission).not.toHaveBeenCalled();
  });

  describe("5m TTL and subagent defaults", () => {
    it("defaults to enabled for subagent when cache_warm is unset", () => {
      const { manager, mockAgent } = createHarness({
        featureEnabled: "default",
        isSubagent: true,
      });

      expect(manager.isFeatureEnabled(mockAgent.id)).toBe(true);
      expect(manager.schedule(mockAgent.id)).toBe(true);
      expect(manager.hasPending(mockAgent.id)).toBe(true);
    });

    it("defaults to enabled for explicit 5m TTL session when cache_warm is unset", () => {
      const { manager, mockAgent } = createHarness({
        featureEnabled: "default",
        isSubagent: false,
        promptCacheTtl: "5m",
      });

      expect(manager.isFeatureEnabled(mockAgent.id)).toBe(true);
      expect(manager.schedule(mockAgent.id)).toBe(true);
      expect(manager.hasPending(mockAgent.id)).toBe(true);
    });

    it("defaults to disabled for root 1h/default TTL session when cache_warm is unset", () => {
      const { manager, mockAgent } = createHarness({
        featureEnabled: "default",
        isSubagent: false,
        promptCacheTtl: "default",
      });

      expect(manager.isFeatureEnabled(mockAgent.id)).toBe(false);
      expect(manager.schedule(mockAgent.id)).toBe(false);
      expect(manager.hasPending(mockAgent.id)).toBe(false);
    });

    it("defaults to disabled for subagent overridden with 1h TTL when cache_warm is unset", () => {
      const { manager, mockAgent } = createHarness({
        featureEnabled: "default",
        isSubagent: true,
        promptCacheTtl: "1h",
      });

      expect(manager.isFeatureEnabled(mockAgent.id)).toBe(false);
      expect(manager.schedule(mockAgent.id)).toBe(false);
    });

    it("respects explicit cache_warm: false even for 5m TTL or subagents", () => {
      const { manager, mockAgent } = createHarness({
        featureEnabled: false,
        isSubagent: true,
        promptCacheTtl: "5m",
      });

      expect(manager.isFeatureEnabled(mockAgent.id)).toBe(false);
      expect(manager.schedule(mockAgent.id)).toBe(false);
    });

    it("respects explicit cache_warm: true for 1h sessions", () => {
      const { manager, mockAgent } = createHarness({
        featureEnabled: true,
        isSubagent: false,
        promptCacheTtl: "1h",
      });

      expect(manager.isFeatureEnabled(mockAgent.id)).toBe(true);
      expect(manager.schedule(mockAgent.id)).toBe(true);
    });
  });

  describe("onTtlChanged dynamic watchdog updates", () => {
    it("dynamically schedules 4m watchdog timer when switching from 1h to 5m", () => {
      const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
      vi.setSystemTime(startTime);

      const { manager, mockAgent } = createHarness({
        featureEnabled: "default",
        isSubagent: false,
        promptCacheTtl: "1h",
        lastResponseAt: new Date(startTime),
      });

      // Initially 1h default: disabled
      expect(manager.isFeatureEnabled(mockAgent.id)).toBe(false);
      expect(manager.hasPending(mockAgent.id)).toBe(false);

      // 1 minute elapses
      vi.setSystemTime(startTime + 60_000);

      // Switch TTL to 5m
      mockAgent.config.featureValues = { prompt_cache_ttl: "5m" };
      manager.onTtlChanged(mockAgent.id);

      // Now enabled by default with 4m interval, remaining 3m
      expect(manager.isFeatureEnabled(mockAgent.id)).toBe(true);
      expect(manager.hasPending(mockAgent.id)).toBe(true);
      const pending = manager.getPending(mockAgent.id);
      expect(pending?.scheduledFor.getTime()).toBe(startTime + 4 * 60_000);
    });

    it("dynamically cancels watchdog timer when switching from 5m to 1h without explicit toggle", () => {
      const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
      vi.setSystemTime(startTime);

      const { manager, mockAgent } = createHarness({
        featureEnabled: "default",
        isSubagent: false,
        promptCacheTtl: "5m",
        lastResponseAt: new Date(startTime),
      });

      expect(manager.schedule(mockAgent.id)).toBe(true);
      expect(manager.hasPending(mockAgent.id)).toBe(true);

      // Switch TTL to 1h
      mockAgent.config.featureValues = { prompt_cache_ttl: "1h" };
      manager.onTtlChanged(mockAgent.id);

      expect(manager.isFeatureEnabled(mockAgent.id)).toBe(false);
      expect(manager.hasPending(mockAgent.id)).toBe(false);
    });

    it("dynamically updates interval from 4m to 58m when switching 5m to 1h with explicit cache_warm: true", () => {
      const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
      vi.setSystemTime(startTime);

      const { manager, mockAgent } = createHarness({
        featureEnabled: true,
        isSubagent: false,
        promptCacheTtl: "5m",
        lastResponseAt: new Date(startTime),
      });

      expect(manager.schedule(mockAgent.id)).toBe(true);
      expect(manager.getPending(mockAgent.id)?.scheduledFor.getTime()).toBe(startTime + 4 * 60_000);

      // 2 minutes elapse
      vi.setSystemTime(startTime + 2 * 60_000);

      // Switch TTL to 1h
      mockAgent.config.featureValues = {
        [CLAUDE_CACHE_WARM_FEATURE_ID]: true,
        prompt_cache_ttl: "1h",
      };
      manager.onTtlChanged(mockAgent.id);

      expect(manager.hasPending(mockAgent.id)).toBe(true);
      expect(manager.getPending(mockAgent.id)?.scheduledFor.getTime()).toBe(
        startTime + 58 * 60_000,
      );
    });

    it("cancels timer and does not reschedule when switching to 5m if cache has already expired", () => {
      const startTime = new Date("2026-10-25T12:00:00.000Z").getTime();
      vi.setSystemTime(startTime);

      const { manager, mockAgent } = createHarness({
        featureEnabled: true,
        isSubagent: false,
        promptCacheTtl: "1h",
        lastResponseAt: new Date(startTime),
      });

      expect(manager.schedule(mockAgent.id)).toBe(true);
      expect(manager.hasPending(mockAgent.id)).toBe(true);

      // 10 minutes elapse (> 5m window)
      vi.setSystemTime(startTime + 10 * 60_000);

      // Switch TTL to 5m
      mockAgent.config.featureValues = {
        [CLAUDE_CACHE_WARM_FEATURE_ID]: true,
        prompt_cache_ttl: "5m",
      };
      manager.onTtlChanged(mockAgent.id);

      // 5m cache window has already passed 10m ago -> cancel without rescheduling
      expect(manager.hasPending(mockAgent.id)).toBe(false);
    });
  });
});
