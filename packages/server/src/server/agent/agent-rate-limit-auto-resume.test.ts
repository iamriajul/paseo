import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import {
  AgentRateLimitAutoResumeManager,
  extractRetryAfterTimestamp,
  readPendingRateLimitRecords,
  writePendingRateLimitRecords,
} from "./agent-rate-limit-auto-resume.js";
import type { AgentStorage } from "./agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { AGENT_LABEL_RATE_LIMIT_AUTO_RESUME } from "@getpaseo/protocol/agent-labels";

describe("extractRetryAfterTimestamp", () => {
  it("extracts valid UTC ISO timestamp from end of message", () => {
    const text =
      "API Error: 429 · All credentials for model gpt-4o are cooling down RETRY_AFTER:2026-10-13T17:30:00Z";
    const date = extractRetryAfterTimestamp(text);
    expect(date).not.toBeNull();
    expect(date?.toISOString()).toBe("2026-10-13T17:30:00.000Z");
  });

  it("extracts timestamp with fractional seconds", () => {
    const text = "Error RETRY_AFTER:2026-10-13T17:30:00.500Z";
    const date = extractRetryAfterTimestamp(text);
    expect(date).not.toBeNull();
    expect(date?.toISOString()).toBe("2026-10-13T17:30:00.500Z");
  });

  it("handles trailing whitespace or newline", () => {
    const text = "Rate limit hit\nRETRY_AFTER:2026-10-13T17:30:00Z   \n";
    const date = extractRetryAfterTimestamp(text);
    expect(date).not.toBeNull();
    expect(date?.toISOString()).toBe("2026-10-13T17:30:00.000Z");
  });

  it("returns null when space is after colon", () => {
    const text = "RETRY_AFTER: 2026-10-13T17:30:00Z";
    expect(extractRetryAfterTimestamp(text)).toBeNull();
  });

  it("returns null for non-UTC or malformed date", () => {
    expect(extractRetryAfterTimestamp("RETRY_AFTER:2026-10-13")).toBeNull();
    expect(extractRetryAfterTimestamp("RETRY_AFTER:not-a-dateZ")).toBeNull();
  });

  it("returns null if RETRY_AFTER is not at the end of the text", () => {
    const text = "RETRY_AFTER:2026-10-13T17:30:00Z please wait 5 minutes";
    expect(extractRetryAfterTimestamp(text)).toBeNull();
  });
});

describe("AgentRateLimitAutoResumeManager", () => {
  let tmpDir: string;
  let logger: pino.Logger;

  beforeEach(async () => {
    vi.useFakeTimers();
    tmpDir = await mkdtemp(path.join(tmpdir(), "paseo-rate-limit-test-"));
    logger = pino({ level: "silent" });
  });

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function createHarness(options?: {
    globalEnabled?: boolean;
    agentLabels?: Record<string, string>;
    archived?: boolean;
    hasInFlightRun?: (agentId: string) => boolean;
  }) {
    const globalEnabled = options?.globalEnabled ?? true;
    const agentLabels = options?.agentLabels ?? {};
    const archived = options?.archived ?? false;
    const hasInFlightRun = options?.hasInFlightRun ?? (() => false);

    const appendTimelineItem = vi.fn().mockResolvedValue(undefined);
    const getAgent = vi.fn().mockImplementation((id: string) => ({
      id,
      labels: agentLabels,
      lifecycle: archived ? "closed" : "idle",
    }));
    const getStored = vi.fn().mockImplementation(async (id: string) => ({
      id,
      labels: agentLabels,
      archivedAt: archived ? "2026-10-13T10:00:00Z" : undefined,
    }));
    const sendPrompt = vi.fn().mockResolvedValue({ disposition: "turn_started" });

    const manager = new AgentRateLimitAutoResumeManager({
      paseoHome: tmpDir,
      agentManager: { appendTimelineItem, getAgent, hasInFlightRun },
      agentStorage: { get: getStored } as unknown as AgentStorage,
      daemonConfigStore: {
        get: () =>
          ({ autoResumeOnRateLimit: globalEnabled }) as unknown as ReturnType<
            DaemonConfigStore["get"]
          >,
      },
      logger,
      sendPrompt,
    });

    return { manager, appendTimelineItem, getAgent, sendPrompt };
  }

  it("schedules auto-resume and executes after delay", async () => {
    const now = new Date("2026-10-13T12:00:00.000Z").getTime();
    vi.setSystemTime(now);

    const { manager, appendTimelineItem, sendPrompt } = createHarness();
    const retryTime = "2026-10-13T12:05:00.000Z";
    const text = `Rate limit error RETRY_AFTER:${retryTime}`;

    const scheduled = manager.scheduleIfNeeded("agent-1", text);
    expect(scheduled).toBe(true);
    expect(manager.hasPending("agent-1")).toBe(true);

    // Advance 4 minutes - should not have fired yet
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(appendTimelineItem).not.toHaveBeenCalled();

    // Advance 1 more minute (total 5 mins) - should fire
    await vi.advanceTimersByTimeAsync(1 * 60 * 1000);
    expect(appendTimelineItem).toHaveBeenCalledWith("agent-1", {
      type: "resume",
      reason: "rate_limit_retry",
    });
    expect(sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        prompt: expect.stringContaining("Resume - rate limit cooldown has ended"),
      }),
    );
    expect(manager.hasPending("agent-1")).toBe(false);
  });

  it("respects global disabled setting", () => {
    const { manager } = createHarness({ globalEnabled: false });
    const text = "Error RETRY_AFTER:2026-10-13T17:30:00Z";
    const scheduled = manager.scheduleIfNeeded("agent-1", text);
    expect(scheduled).toBe(false);
    expect(manager.hasPending("agent-1")).toBe(false);
  });

  it("respects per-agent disabled label", () => {
    const { manager } = createHarness({
      agentLabels: { [AGENT_LABEL_RATE_LIMIT_AUTO_RESUME]: "false" },
    });
    const text = "Error RETRY_AFTER:2026-10-13T17:30:00Z";
    const scheduled = manager.scheduleIfNeeded("agent-1", text);
    expect(scheduled).toBe(false);
    expect(manager.hasPending("agent-1")).toBe(false);
  });

  it("cancels pending timer upon request", async () => {
    const now = new Date("2026-10-13T12:00:00.000Z").getTime();
    vi.setSystemTime(now);

    const { manager, appendTimelineItem } = createHarness();
    manager.scheduleIfNeeded("agent-1", "Error RETRY_AFTER:2026-10-13T12:05:00Z");
    expect(manager.hasPending("agent-1")).toBe(true);

    manager.cancel("agent-1");
    await manager.waitForPersistence();
    expect(manager.hasPending("agent-1")).toBe(false);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(appendTimelineItem).not.toHaveBeenCalled();
  });

  it("persists pending timers to disk and restores on bootstrap", async () => {
    const now = new Date("2026-10-13T12:00:00.000Z").getTime();
    vi.setSystemTime(now);

    const { manager } = createHarness();
    manager.scheduleIfNeeded("agent-persist", "Error RETRY_AFTER:2026-10-13T12:10:00Z");
    await manager.waitForPersistence();

    const records = await readPendingRateLimitRecords(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].agentId).toBe("agent-persist");

    // Clear memory timer as if daemon restarted
    manager.cancelAll();
    expect(manager.hasPending("agent-persist")).toBe(false);

    // Pre-populate records on disk
    await writePendingRateLimitRecords(tmpDir, [
      {
        agentId: "agent-future",
        scheduledFor: "2026-10-13T12:15:00.000Z",
        retryAfter: "2026-10-13T12:15:00.000Z",
        createdAt: "2026-10-13T12:00:00.000Z",
      },
      {
        agentId: "agent-expired",
        scheduledFor: "2026-10-13T11:55:00.000Z", // already in the past
        retryAfter: "2026-10-13T11:55:00.000Z",
        createdAt: "2026-10-13T11:50:00.000Z",
      },
    ]);

    const { manager: newManager, appendTimelineItem } = createHarness();
    await newManager.bootstrap();

    // Expired one should fire immediately
    expect(appendTimelineItem).toHaveBeenCalledWith("agent-expired", {
      type: "resume",
      reason: "rate_limit_retry",
    });

    // Future one should be scheduled
    expect(newManager.hasPending("agent-future")).toBe(true);
  });

  it("does not schedule live auto-resume if timestamp is already in the past", () => {
    const now = new Date("2026-10-13T12:00:00.000Z").getTime();
    vi.setSystemTime(now);

    const { manager } = createHarness();
    const pastTime = "2026-10-13T11:59:00.000Z";
    const text = `Rate limit error RETRY_AFTER:${pastTime}`;

    const scheduled = manager.scheduleIfNeeded("agent-1", text);
    expect(scheduled).toBe(false);
    expect(manager.hasPending("agent-1")).toBe(false);
  });

  it("replaces existing timer when consecutive rate limit triggers arrive", async () => {
    const now = new Date("2026-10-13T12:00:00.000Z").getTime();
    vi.setSystemTime(now);

    const { manager, appendTimelineItem, sendPrompt } = createHarness();
    const time1 = "2026-10-13T12:05:00.000Z";
    const time2 = "2026-10-13T12:15:00.000Z";

    // Turn 1 arrives with initial cooldown
    manager.scheduleIfNeeded("agent-1", `Error RETRY_AFTER:${time1}`);
    expect(manager.hasPending("agent-1")).toBe(true);
    expect(manager.getPending("agent-1")?.retryAfter).toBe(time1);

    // Turn 2 arrives with extended cooldown before timer fires
    manager.scheduleIfNeeded("agent-1", `Error RETRY_AFTER:${time2}`);
    expect(manager.hasPending("agent-1")).toBe(true);
    expect(manager.getPending("agent-1")?.retryAfter).toBe(time2);

    // Advancing past time1 should NOT fire
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
    expect(appendTimelineItem).not.toHaveBeenCalled();

    // Advancing past time2 SHOULD fire
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(appendTimelineItem).toHaveBeenCalledWith("agent-1", {
      type: "resume",
      reason: "rate_limit_retry",
    });
    expect(sendPrompt).toHaveBeenCalled();
  });

  it("aborts resume if canceled while resume execution is in-flight", async () => {
    const now = new Date("2026-10-13T12:00:00.000Z").getTime();
    vi.setSystemTime(now);

    const { manager, appendTimelineItem } = createHarness();
    const retryTime = "2026-10-13T12:05:00.000Z";
    manager.scheduleIfNeeded("agent-1", `Error RETRY_AFTER:${retryTime}`);

    // Cancel while timer is armed
    manager.cancel("agent-1");

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(appendTimelineItem).not.toHaveBeenCalled();
  });

  it("aborts resume if agent already has an in-flight run", async () => {
    const now = new Date("2026-10-13T12:00:00.000Z").getTime();
    vi.setSystemTime(now);

    const { manager, appendTimelineItem } = createHarness({
      hasInFlightRun: () => true,
    });
    const retryTime = "2026-10-13T12:05:00.000Z";
    manager.scheduleIfNeeded("agent-1", `Error RETRY_AFTER:${retryTime}`);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(appendTimelineItem).not.toHaveBeenCalled();
  });

  it("caps maximum consecutive auto-resumes at 10", async () => {
    const now = new Date("2026-10-13T12:00:00.000Z").getTime();
    vi.setSystemTime(now);

    const { manager, appendTimelineItem } = createHarness();

    // Trigger 10 resumes consecutively
    for (let i = 1; i <= 10; i++) {
      const retryTime = new Date(now + i * 1000).toISOString();
      manager.scheduleIfNeeded("agent-1", `Error RETRY_AFTER:${retryTime}`);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(appendTimelineItem).toHaveBeenCalledTimes(10);

    // 11th should be capped
    const retryTime11 = new Date(now + 12000).toISOString();
    manager.scheduleIfNeeded("agent-1", `Error RETRY_AFTER:${retryTime11}`);
    await vi.advanceTimersByTimeAsync(2000);
    expect(appendTimelineItem).toHaveBeenCalledTimes(10);

    // Reset allows resuming again
    manager.resetConsecutiveResumes("agent-1");
    const retryTime12 = new Date(now + 15000).toISOString();
    manager.scheduleIfNeeded("agent-1", `Error RETRY_AFTER:${retryTime12}`);
    await vi.advanceTimersByTimeAsync(3000);
    expect(appendTimelineItem).toHaveBeenCalledTimes(11);
  });
});
