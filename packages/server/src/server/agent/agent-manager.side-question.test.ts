import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { SIDE_QUESTION_OF_LABEL } from "@getpaseo/protocol/agent-labels";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";
import type { ClaudeRewindSdk } from "./providers/claude/rewind.js";

const logger = createTestLogger();

const CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsSessionListing: false,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
  supportsNativeFork: true,
} as const;

/** A Claude-shaped session: it has a session id, a transcript path and a resolvable boundary. */
class FakeClaudeSession implements AgentSession {
  readonly provider = "claude" as const;
  readonly capabilities = CAPABILITIES;
  readonly id: string;
  private subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turn = 0;

  constructor(
    readonly config: AgentSessionConfig,
    sessionId: string,
  ) {
    this.id = sessionId;
  }

  async run() {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(): Promise<{ turnId: string }> {
    const turnId = `turn-${++this.turn}`;
    setTimeout(() => {
      this.push({ type: "turn_started", provider: this.provider, turnId });
      this.push({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: { type: "assistant_message", text: `answer ${turnId}`, messageId: `msg-${turnId}` },
      });
      this.push({ type: "turn_completed", provider: this.provider, turnId });
    }, 0);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private push(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) callback(event);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}
  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode(): Promise<void> {}
  getPendingPermissions() {
    return [];
  }
  async respondToPermission(): Promise<void> {}
  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}

  async resolveNativeForkTranscriptPath(sessionId: string): Promise<string> {
    return `/tmp/projects/${sessionId}.jsonl`;
  }
  async resolveNativeForkUpToMessageId(boundaryMessageId: string): Promise<string> {
    return `uuid-of-${boundaryMessageId}`;
  }
}

class FakeClaudeClient implements AgentClient {
  readonly provider = "claude" as const;
  readonly capabilities = CAPABILITIES;
  readonly resumed: Array<{
    handle: AgentPersistenceHandle;
    config: Partial<AgentSessionConfig> | undefined;
  }> = [];

  async isAvailable() {
    return true;
  }
  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new FakeClaudeSession(config, `session-${randomUUID()}`);
  }
  async resumeSession(
    handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.resumed.push({ handle, config });
    return new FakeClaudeSession(
      { provider: "claude", cwd: config?.cwd ?? process.cwd(), ...config },
      handle.sessionId,
    );
  }
  async fetchCatalog() {
    return { models: [], modes: [] };
  }
}

interface ForkCall {
  sessionId: string;
  upToMessageId?: string;
  transcriptPath: string;
}

let workdir: string;
let storage: AgentStorage;
let client: FakeClaudeClient;
let forks: ForkCall[];
let attention: string[];
let manager: AgentManager;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "agent-manager-side-question-"));
  storage = new AgentStorage(join(workdir, "agents"), logger);
  client = new FakeClaudeClient();
  forks = [];
  attention = [];
  const sdk: ClaudeRewindSdk = {
    async forkSession(sessionId, options) {
      forks.push({ sessionId, ...options });
      return { sessionId: `fork-${forks.length}` };
    },
  };
  manager = new AgentManager({
    clients: { claude: client },
    registry: storage,
    logger,
    claudeForkSdk: sdk,
    onAgentAttention: (event) => attention.push(`${event.agentId}:${event.reason}`),
  });
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

async function createSource(labels: Record<string, string> = {}) {
  const source = await manager.createAgent(
    {
      provider: "claude",
      cwd: workdir,
      model: "claude-opus-5-5",
      modeId: "bypassPermissions",
      featureValues: { prompt_cache_ttl: "1h", cache_warm: true, cache_auto_compact: true },
      mcpServers: { paseo: { type: "http", url: "http://127.0.0.1:1/mcp" } },
    },
    undefined,
    { workspaceId: "ws-1", labels },
  );
  await manager.runAgent(source.id, "hello");
  return source;
}

describe("openSideQuestion", () => {
  test("forks the whole transcript at the latest point into the source's workspace", async () => {
    const source = await createSource();
    const sourceSessionId = manager.getAgent(source.id)?.persistence?.sessionId;

    const { agentId, workspaceId } = await manager.openSideQuestion({ sourceAgentId: source.id });

    expect(forks).toEqual([
      { sessionId: sourceSessionId, transcriptPath: `/tmp/projects/${sourceSessionId}.jsonl` },
    ]);
    expect(forks[0]).not.toHaveProperty("upToMessageId");
    expect(workspaceId).toBe("ws-1");
    const side = manager.getAgent(agentId);
    expect(side?.persistence?.sessionId).toBe("fork-1");
    expect(manager.getAgent(source.id)?.persistence?.sessionId).toBe(sourceSessionId);
  });

  test("forks at an earlier reply when given a boundary", async () => {
    const source = await createSource();
    await manager.openSideQuestion({
      sourceAgentId: source.id,
      boundaryMessageId: "msg-turn-1",
    });
    expect(forks[0]?.upToMessageId).toBe("uuid-of-msg-turn-1");
  });

  test("keeps the prefix-shaping launch options and drops everything that acts", async () => {
    const source = await createSource({ "paseo.parent-agent-id": "orchestrator" });
    const sourceSessionId = manager.getAgent(source.id)?.persistence?.sessionId;
    const { agentId } = await manager.openSideQuestion({ sourceAgentId: source.id });
    const side = manager.getAgent(agentId);

    expect(side?.config.model).toBe("claude-opus-5-5");
    expect(side?.config.featureValues?.prompt_cache_ttl).toBe("1h");
    expect(side?.config.sideQuestion).toBe(true);
    expect(side?.config.modeId).toBe("default");
    expect(side?.config.mcpServers).toEqual({});
    expect(side?.config.featureValues?.cache_warm).toBe(false);
    expect(side?.config.featureValues?.cache_auto_compact).toBe(false);
    expect(side?.config.providerOptions?.sessionAffinityId).toBe(sourceSessionId);
    // Only its own label: the source's parent label would make it a subagent.
    expect(side?.labels).toMatchObject({ [SIDE_QUESTION_OF_LABEL]: source.id });
    expect(side?.labels).not.toHaveProperty("paseo.parent-agent-id");
  });

  test("refuses a side question of a side question", async () => {
    const source = await createSource();
    const { agentId } = await manager.openSideQuestion({ sourceAgentId: source.id });
    await expect(manager.openSideQuestion({ sourceAgentId: agentId })).rejects.toThrow(
      /cannot have side questions/,
    );
  });
});

describe("a side question's settings are locked", () => {
  test.each([
    ["mode", (id: string) => manager.setAgentMode(id, "bypassPermissions")],
    ["model", (id: string) => manager.setAgentModel(id, "claude-haiku-5-5")],
    ["thinking option", (id: string) => manager.setAgentThinkingOption(id, "high")],
    ["feature", (id: string) => manager.setAgentFeature(id, "cache_auto_compact", true)],
    [
      "configuration",
      (id: string) => manager.reloadAgentSession(id, { modeId: "bypassPermissions" }),
    ],
  ])("rejects changing its %s", async (_what, change) => {
    const source = await createSource();
    const { agentId } = await manager.openSideQuestion({ sourceAgentId: source.id });
    await expect(change(agentId)).rejects.toThrow(/read-only/);
    expect(manager.getAgent(agentId)?.config.modeId).toBe("default");
  });

  test("the source's own settings still change", async () => {
    const source = await createSource();
    await manager.openSideQuestion({ sourceAgentId: source.id });
    await expect(
      manager.setAgentFeature(source.id, "cache_auto_compact", false),
    ).resolves.toBeUndefined();
  });
});

describe("continuing a side question as a full session", () => {
  test("forks it with the main chat's mode and tools and none of the side question's limits", async () => {
    const source = await createSource();
    const { agentId } = await manager.openSideQuestion({ sourceAgentId: source.id });
    await manager.runAgent(agentId, "what happened?");

    const forked = await manager.nativeForkAgent({ sourceAgentId: agentId });
    const full = manager.getAgent(forked.agentId);

    expect(full?.config.modeId).toBe("bypassPermissions");
    expect(full?.config.mcpServers).toEqual({
      paseo: { type: "http", url: "http://127.0.0.1:1/mcp" },
    });
    expect(full?.config.sideQuestion).toBeUndefined();
    expect(full?.labels).not.toHaveProperty(SIDE_QUESTION_OF_LABEL);
    expect(full?.labels.nativeForkOf).toBe(agentId);
    await expect(manager.setAgentMode(forked.agentId, "default")).resolves.not.toThrow();
  });
});

describe("a side question's life", () => {
  test("is archived with its chat", async () => {
    const source = await createSource();
    const { agentId } = await manager.openSideQuestion({ sourceAgentId: source.id });
    await manager.archiveAgent(source.id);
    expect((await storage.get(agentId))?.archivedAt).toEqual(expect.any(String));
  });

  test("an answer marks its chat for attention but never sends a notification", async () => {
    const source = await createSource();
    const { agentId } = await manager.openSideQuestion({ sourceAgentId: source.id });
    attention.length = 0;
    await manager.runAgent(agentId, "what happened?");
    await manager.flush();
    expect(manager.getAgent(agentId)?.attention).toMatchObject({
      requiresAttention: true,
      attentionReason: "finished",
    });
    expect(attention).toEqual([]);
  });

  test("its runtime stops after five idle minutes, with the host setting off or on", async () => {
    const source = await createSource();
    const { agentId } = await manager.openSideQuestion({ sourceAgentId: source.id });
    const candidates = manager.getRuntimeCleanupCandidates();
    expect(candidates.find((candidate) => candidate.agentId === agentId)?.idleAfterMs).toBe(
      5 * 60_000,
    );
    expect(
      candidates.find((candidate) => candidate.agentId === source.id)?.idleAfterMs,
    ).toBeUndefined();
  });
});
