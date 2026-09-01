import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import pino from "pino";

import {
  DEFAULT_AUTO_RESUME_PROMPT,
  autoResumeRunningAgents,
  captureRunningAgentsForShutdown,
  clearPendingAutoResume,
  getPendingAutoResumePath,
  readPendingAutoResume,
  writePendingAutoResume,
} from "./agent-auto-resume.js";
import type { StoredAgentRecord } from "./agent-storage.js";

function createLogger() {
  return pino({ level: "silent" });
}

function makeRecord(overrides: Partial<StoredAgentRecord> & { id: string }): StoredAgentRecord {
  return {
    provider: "claude",
    cwd: "/tmp/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    labels: {},
    lastStatus: "running",
    config: null,
    persistence: { provider: "claude", sessionId: `sess-${overrides.id}` },
    ...overrides,
  } as StoredAgentRecord;
}

describe("agent-auto-resume pending file helpers", () => {
  test("write and read pending file round-trips", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-auto-resume-"));
    const logger = createLogger();
    try {
      await writePendingAutoResume(dir, ["a", "b"], logger);
      const ids = await readPendingAutoResume(dir, logger);
      expect(ids).toEqual(["a", "b"]);
      const raw = JSON.parse(await readFile(getPendingAutoResumePath(dir), "utf8"));
      expect(raw.agentIds).toEqual(["a", "b"]);
      expect(typeof raw.capturedAt).toBe("string");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("write with empty array clears file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-auto-resume-"));
    const logger = createLogger();
    try {
      await writePendingAutoResume(dir, ["x"], logger);
      await writePendingAutoResume(dir, [], logger);
      const ids = await readPendingAutoResume(dir, logger);
      expect(ids).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("read returns null when file missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-auto-resume-"));
    const logger = createLogger();
    try {
      const ids = await readPendingAutoResume(dir, logger);
      expect(ids).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("read returns null on invalid JSON", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-auto-resume-"));
    const logger = createLogger();
    try {
      await writeFile(getPendingAutoResumePath(dir), "not json", "utf8");
      const ids = await readPendingAutoResume(dir, logger);
      expect(ids).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("deduplicates agentIds", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-auto-resume-"));
    const logger = createLogger();
    try {
      await writePendingAutoResume(dir, ["a", "a", "b"], logger);
      const ids = await readPendingAutoResume(dir, logger);
      expect(ids).toEqual(["a", "b"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("clear removes file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-auto-resume-"));
    const logger = createLogger();
    try {
      await writePendingAutoResume(dir, ["x"], logger);
      await clearPendingAutoResume(dir, logger);
      const ids = await readPendingAutoResume(dir, logger);
      expect(ids).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("captureRunningAgentsForShutdown", () => {
  test("captures only running and initializing agents", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-auto-resume-"));
    const logger = createLogger();
    try {
      const manager = {
        listAgents: () => [
          { id: "running-1", lifecycle: "running", internal: false },
          { id: "idle-1", lifecycle: "idle", internal: false },
          { id: "init-1", lifecycle: "initializing", internal: false },
          { id: "error-1", lifecycle: "error", internal: false },
          { id: "internal-running", lifecycle: "running", internal: true },
        ],
      } as unknown as import("./agent-manager.js").AgentManager;
      await captureRunningAgentsForShutdown(dir, manager, logger);
      const ids = await readPendingAutoResume(dir, logger);
      expect(ids).toEqual(expect.arrayContaining(["running-1", "init-1"]));
      expect(ids).not.toContain("idle-1");
      expect(ids).not.toContain("error-1");
      expect(ids).not.toContain("internal-running");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("clears file when no running agents", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-auto-resume-"));
    const logger = createLogger();
    try {
      const manager = {
        listAgents: () => [{ id: "idle-1", lifecycle: "idle", internal: false }],
      } as unknown as import("./agent-manager.js").AgentManager;
      await writePendingAutoResume(dir, ["old"], logger);
      await captureRunningAgentsForShutdown(dir, manager, logger);
      const ids = await readPendingAutoResume(dir, logger);
      expect(ids).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips capture for intentional daemon shutdown (client_shutdown_rpc)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-auto-resume-"));
    const logger = createLogger();
    try {
      const manager = {
        listAgents: () => [{ id: "running-1", lifecycle: "running", internal: false }],
      } as unknown as import("./agent-manager.js").AgentManager;
      await captureRunningAgentsForShutdown(dir, manager, logger, "client_shutdown_rpc");
      const ids = await readPendingAutoResume(dir, logger);
      expect(ids).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips capture for intentional restart (client_restart_rpc)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-auto-resume-"));
    const logger = createLogger();
    try {
      const manager = {
        listAgents: () => [{ id: "running-1", lifecycle: "running", internal: false }],
      } as unknown as import("./agent-manager.js").AgentManager;
      await captureRunningAgentsForShutdown(dir, manager, logger, "client_restart_rpc");
      const ids = await readPendingAutoResume(dir, logger);
      expect(ids).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("captures for unexpected SIGTERM", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-auto-resume-"));
    const logger = createLogger();
    try {
      const manager = {
        listAgents: () => [{ id: "running-1", lifecycle: "running", internal: false }],
      } as unknown as import("./agent-manager.js").AgentManager;
      await captureRunningAgentsForShutdown(dir, manager, logger, "worker_received_SIGTERM");
      const ids = await readPendingAutoResume(dir, logger);
      expect(ids).toEqual(["running-1"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("autoResumeRunningAgents", () => {
  test("resumes agents with pending file and running status", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-auto-resume-"));
    const logger = createLogger();
    try {
      const runningId = "11111111-1111-4111-8111-111111111111";
      const runningViaStorageId = "22222222-2222-4222-8222-222222222222";
      const pendingClosedId = "33333333-3333-4333-8333-333333333333";
      const idleId = "44444444-4444-4444-8444-444444444444";

      // pending file contains one running and one closed-by-shutdown
      await writePendingAutoResume(dir, [runningId, pendingClosedId], logger);

      const records: StoredAgentRecord[] = [
        makeRecord({ id: runningId, lastStatus: "running" }),
        makeRecord({ id: runningViaStorageId, lastStatus: "running" }),
        // pendingClosedId was running before shutdown but now persisted as closed
        makeRecord({ id: pendingClosedId, lastStatus: "closed" }),
        makeRecord({ id: idleId, lastStatus: "idle" }),
        makeRecord({
          id: "archived-1",
          lastStatus: "running",
          archivedAt: new Date().toISOString(),
        }),
        makeRecord({ id: "internal-1", lastStatus: "running", internal: true }),
      ];

      const storage = {
        list: async () => records,
        get: async (id: string) => records.find((r) => r.id === id) ?? null,
      } as unknown as import("./agent-storage.js").AgentStorage;

      const manager = {} as import("./agent-manager.js").AgentManager;

      const sendMock = vi.fn(async () => ({ disposition: "turn_started" }));

      const result = await autoResumeRunningAgents({
        paseoHome: dir,
        agentManager: manager,
        agentStorage: storage,
        logger,
        prompt: "resume",
        sendPrompt: sendMock as unknown as typeof import("./agent-prompt.js").sendPromptToAgent,
      });

      // Should attempt runningId (from both pending+storage), runningViaStorageId, pendingClosedId
      // idle, archived, internal should be skipped
      expect(result.attempted).toBe(3);
      expect(result.succeeded).toBe(3);
      expect(result.failed).toBe(0);
      expect(sendMock).toHaveBeenCalledTimes(3);
      const calledIds = sendMock.mock.calls.map((c) => c[0].agentId);
      expect(calledIds).toEqual(
        expect.arrayContaining([runningId, runningViaStorageId, pendingClosedId]),
      );
      expect(calledIds).not.toContain(idleId);

      // pending file cleared after run
      const after = await readPendingAutoResume(dir, logger);
      expect(after).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does nothing when no resumable agents", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-auto-resume-"));
    const logger = createLogger();
    try {
      const records: StoredAgentRecord[] = [
        makeRecord({ id: "idle-1", lastStatus: "idle" }),
        makeRecord({ id: "closed-1", lastStatus: "closed" }),
      ];
      const storage = {
        list: async () => records,
        get: async (id: string) => records.find((r) => r.id === id) ?? null,
      } as unknown as import("./agent-storage.js").AgentStorage;
      const manager = {} as import("./agent-manager.js").AgentManager;
      const sendMock = vi.fn(async () => ({ disposition: "turn_started" }));
      const result = await autoResumeRunningAgents({
        paseoHome: dir,
        agentManager: manager,
        agentStorage: storage,
        logger,
        sendPrompt: sendMock as unknown as typeof import("./agent-prompt.js").sendPromptToAgent,
      });
      expect(result.attempted).toBe(0);
      expect(sendMock).not.toHaveBeenCalled();
      const after = await readPendingAutoResume(dir, logger);
      expect(after).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("disabled clears pending and does not send", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-auto-resume-"));
    const logger = createLogger();
    try {
      await writePendingAutoResume(dir, ["a"], logger);
      const storage = {
        list: async () => [makeRecord({ id: "a", lastStatus: "running" })],
        get: async (id: string) => makeRecord({ id, lastStatus: "running" }),
      } as unknown as import("./agent-storage.js").AgentStorage;
      const manager = {} as import("./agent-manager.js").AgentManager;
      const sendMock = vi.fn(async () => ({ disposition: "turn_started" }));
      const result = await autoResumeRunningAgents({
        paseoHome: dir,
        agentManager: manager,
        agentStorage: storage,
        logger,
        enabled: false,
        sendPrompt: sendMock as unknown as typeof import("./agent-prompt.js").sendPromptToAgent,
      });
      expect(result.attempted).toBe(0);
      expect(sendMock).not.toHaveBeenCalled();
      const after = await readPendingAutoResume(dir, logger);
      expect(after).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips resume when pending reason is intentional daemon stop", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-auto-resume-"));
    const logger = createLogger();
    try {
      await writePendingAutoResume(dir, ["a"], logger, "client_shutdown_rpc");
      const storage = {
        list: async () => [makeRecord({ id: "a", lastStatus: "closed" })],
        get: async (id: string) => makeRecord({ id, lastStatus: "closed" }),
      } as unknown as import("./agent-storage.js").AgentStorage;
      const manager = {} as import("./agent-manager.js").AgentManager;
      const sendMock = vi.fn(async () => ({ disposition: "turn_started" }));
      const result = await autoResumeRunningAgents({
        paseoHome: dir,
        agentManager: manager,
        agentStorage: storage,
        logger,
        sendPrompt: sendMock as unknown as typeof import("./agent-prompt.js").sendPromptToAgent,
      });
      expect(result.attempted).toBe(0);
      expect(sendMock).not.toHaveBeenCalled();
      const after = await readPendingAutoResume(dir, logger);
      expect(after).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("handles send failure and reports failed count", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-auto-resume-"));
    const logger = createLogger();
    try {
      const id1 = "55555555-5555-4555-8555-555555555555";
      const id2 = "66666666-6666-4666-8666-666666666666";
      const records: StoredAgentRecord[] = [
        makeRecord({ id: id1, lastStatus: "running" }),
        makeRecord({ id: id2, lastStatus: "running" }),
      ];
      const storage = {
        list: async () => records,
        get: async (id: string) => records.find((r) => r.id === id) ?? null,
      } as unknown as import("./agent-storage.js").AgentStorage;
      const manager = {} as import("./agent-manager.js").AgentManager;
      const sendMock = vi.fn(async ({ agentId }: { agentId: string }) => {
        if (agentId === id1) throw new Error("provider unavailable");
        return { disposition: "turn_started" };
      });
      const result = await autoResumeRunningAgents({
        paseoHome: dir,
        agentManager: manager,
        agentStorage: storage,
        logger,
        sendPrompt: sendMock as unknown as typeof import("./agent-prompt.js").sendPromptToAgent,
      });
      expect(result.attempted).toBe(2);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(1);
      const after = await readPendingAutoResume(dir, logger);
      expect(after).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses default prompt when not provided", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-auto-resume-"));
    const logger = createLogger();
    try {
      const id = "77777777-7777-4777-8777-777777777777";
      const records: StoredAgentRecord[] = [makeRecord({ id, lastStatus: "running" })];
      const storage = {
        list: async () => records,
        get: async () => records[0],
      } as unknown as import("./agent-storage.js").AgentStorage;
      const manager = {} as import("./agent-manager.js").AgentManager;
      const sendMock = vi.fn(async () => ({ disposition: "turn_started" }));
      await autoResumeRunningAgents({
        paseoHome: dir,
        agentManager: manager,
        agentStorage: storage,
        logger,
        sendPrompt: sendMock as unknown as typeof import("./agent-prompt.js").sendPromptToAgent,
      });
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: DEFAULT_AUTO_RESUME_PROMPT }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("trims custom prompt", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-auto-resume-"));
    const logger = createLogger();
    try {
      const id = "88888888-8888-4888-8888-888888888888";
      const records: StoredAgentRecord[] = [makeRecord({ id, lastStatus: "running" })];
      const storage = {
        list: async () => records,
        get: async () => records[0],
      } as unknown as import("./agent-storage.js").AgentStorage;
      const manager = {} as import("./agent-manager.js").AgentManager;
      const sendMock = vi.fn(async () => ({ disposition: "turn_started" }));
      await autoResumeRunningAgents({
        paseoHome: dir,
        agentManager: manager,
        agentStorage: storage,
        logger,
        prompt: "  custom resume  ",
        sendPrompt: sendMock as unknown as typeof import("./agent-prompt.js").sendPromptToAgent,
      });
      expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ prompt: "custom resume" }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("respects maxConcurrency batching", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-auto-resume-"));
    const logger = createLogger();
    try {
      const ids = Array.from({ length: 6 }, (_, i) => `0000000${i}-0000-4000-8000-00000000000${i}`);
      const records: StoredAgentRecord[] = ids.map((id) =>
        makeRecord({ id, lastStatus: "running" }),
      );
      const storage = {
        list: async () => records,
        get: async (id: string) => records.find((r) => r.id === id) ?? null,
      } as unknown as import("./agent-storage.js").AgentStorage;
      const manager = {} as import("./agent-manager.js").AgentManager;
      let concurrent = 0;
      let maxObserved = 0;
      const sendMock = vi.fn(async () => {
        concurrent++;
        maxObserved = Math.max(maxObserved, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
        return { disposition: "turn_started" };
      });
      await autoResumeRunningAgents({
        paseoHome: dir,
        agentManager: manager,
        agentStorage: storage,
        logger,
        maxConcurrency: 2,
        sendPrompt: sendMock as unknown as typeof import("./agent-prompt.js").sendPromptToAgent,
      });
      expect(maxObserved).toBeLessThanOrEqual(2);
      expect(sendMock).toHaveBeenCalledTimes(6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("config integration", () => {
  test("reads PASEO_AUTO_RESUME_ENABLED and PASEO_AUTO_RESUME_PROMPT", async () => {
    const { resolveConfigFromPersisted } = await import("../config.js");
    const { loadPersistedConfig } = await import("../persisted-config.js");
    // use tmpdir for paseoHome to avoid touching real home
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-config-test-"));
    try {
      const persisted = loadPersistedConfig(dir);
      const config1 = resolveConfigFromPersisted(dir, persisted, {
        env: {
          ...process.env,
          PASEO_AUTO_RESUME_ENABLED: "false",
          PASEO_AUTO_RESUME_PROMPT: "  continue now ",
        },
      });
      expect(config1.autoResumeRunningAgents?.enabled).toBe(false);
      expect(config1.autoResumeRunningAgents?.prompt).toBe("continue now");

      const config2 = resolveConfigFromPersisted(
        dir,
        {
          ...persisted,
          daemon: {
            ...persisted.daemon,
            autoResumeRunningAgents: { enabled: false, prompt: "from persisted" },
          },
        },
        { env: {} },
      );
      expect(config2.autoResumeRunningAgents?.enabled).toBe(false);
      expect(config2.autoResumeRunningAgents?.prompt).toBe("from persisted");

      const config3 = resolveConfigFromPersisted(dir, persisted, { env: {} });
      expect(config3.autoResumeRunningAgents?.enabled).toBe(true);
      expect(config3.autoResumeRunningAgents?.prompt).toBe("Resume - there was a power cut");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
