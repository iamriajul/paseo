import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ForgeService } from "../../services/forge-service.js";
import { defaultForgeRegistry } from "../../services/forge-registry.js";
import type { CheckoutSnapshotFacts, CheckoutStatusGit } from "../../utils/checkout-git.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import { WorkspaceGitServiceImpl } from "../workspace-git-service.js";
import { createGitRemotePollGate, type GitRemotePollGate } from "./git-remote-poll-gate.js";
import {
  GIT_REMOTE_POLL_QUIET_MS,
  nextRemotePollQuietDeadlineMs,
  selectRemotePollCwds,
  type RemotePollAgentClock,
  type RemotePollInput,
} from "./select-remote-poll-cwds.js";

const CWD = "/tmp/repo";
const OTHER = "/tmp/other";
const NOW = 1_000_000_000_000;

function clock(cwd: string, ageMs: number, archived = false): RemotePollAgentClock {
  return { cwd, updatedAtMs: NOW - ageMs, archived };
}

function input(
  agents: readonly RemotePollAgentClock[],
  openCwds: readonly string[] = [],
): RemotePollInput {
  return { nowMs: NOW, agents, openCwds: new Set(openCwds) };
}

describe("selectRemotePollCwds", () => {
  test("a non-archived updatedAt older than 6 hours is out, and exactly 6 hours is out", () => {
    expect(selectRemotePollCwds(input([clock(CWD, GIT_REMOTE_POLL_QUIET_MS + 1)]))).not.toContain(
      CWD,
    );
    expect(selectRemotePollCwds(input([clock(CWD, GIT_REMOTE_POLL_QUIET_MS)]))).not.toContain(CWD);
  });

  test("updatedAt of now is in, and the function has no statusEnteredAt so a 7 hour old clock is out", () => {
    expect(selectRemotePollCwds(input([clock(CWD, 0)]))).toContain(CWD);
    expect(selectRemotePollCwds(input([clock(CWD, 7 * 60 * 60 * 1000)]))).not.toContain(CWD);
  });

  test("the newest non-archived updatedAt on a directory wins", () => {
    const selected = selectRemotePollCwds(
      input([clock(CWD, GIT_REMOTE_POLL_QUIET_MS + 1), clock(CWD, 60_000), clock(CWD, 0, true)]),
    );
    expect(selected).toContain(CWD);
  });

  test("an archived agent clock does not put its directory in the set", () => {
    expect(selectRemotePollCwds(input([clock(CWD, 0, true)]))).not.toContain(CWD);
  });

  test("a non-finite updatedAt does not admit a directory", () => {
    expect(
      selectRemotePollCwds(input([{ cwd: CWD, updatedAtMs: Number.NaN, archived: false }])),
    ).not.toContain(CWD);
  });

  test("an open directory with a stale agent is in the set", () => {
    expect(
      selectRemotePollCwds(input([clock(CWD, GIT_REMOTE_POLL_QUIET_MS + 1)], [CWD])),
    ).toContain(CWD);
  });

  test("open members arm no quiet deadline, and the soonest non-open member does", () => {
    const agents = [clock(CWD, 60_000), clock(OTHER, 2 * 60_000)];
    expect(nextRemotePollQuietDeadlineMs(input(agents, [CWD, OTHER]))).toBeNull();
    expect(nextRemotePollQuietDeadlineMs(input(agents, [CWD]))).toBe(
      NOW - 2 * 60_000 + GIT_REMOTE_POLL_QUIET_MS,
    );
    expect(nextRemotePollQuietDeadlineMs(input([]))).toBeNull();
  });
});

const QUIET_CWD = path.resolve("/tmp/git-remote-poll-quiet");
const SIBLING_CWD = path.resolve("/tmp/git-remote-poll-sibling");
const SHARED_GIT_DIR = path.resolve("/tmp/git-remote-poll-shared.git");

function checkoutFacts(
  cwd: string,
  remoteUrl: string,
  gitCommonDir: string,
): CheckoutSnapshotFacts {
  return {
    isGit: true,
    worktreeRoot: cwd,
    currentBranch: "feature",
    remoteUrl,
    absoluteGitDir: path.join(gitCommonDir, "worktrees", path.basename(cwd)),
    gitCommonDir,
    paseoWorktree: { isPaseoOwnedWorktree: false },
    storedBaseRef: null,
    resolvedBaseRef: "main",
    mainRepoRoot: null,
    comparisonBaseRef: null,
    branchRemoteName: "origin",
    branchMergeRef: "refs/heads/main",
    pullRequestLookupTarget: { headRef: "feature" },
    upstreamStatus: null,
  } as CheckoutSnapshotFacts;
}

function checkoutStatus(cwd: string, remoteUrl: string): CheckoutStatusGit {
  return {
    isGit: true,
    repoRoot: cwd,
    mainRepoRoot: null,
    currentBranch: "feature",
    isDirty: false,
    baseRef: "main",
    aheadBehind: { ahead: 0, behind: 0 },
    aheadOfOrigin: 0,
    behindOfOrigin: 0,
    hasRemote: true,
    remoteUrl,
    isPaseoOwnedWorktree: false,
  };
}

function createLogger() {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  };
  return logger;
}

interface PollHarness {
  service: WorkspaceGitServiceImpl;
  runGitFetch: ReturnType<typeof vi.fn>;
  retain: ReturnType<typeof vi.fn>;
  getPullRequestStatus: ReturnType<typeof vi.fn>;
  getCurrentPullRequestStatus: ReturnType<typeof vi.fn>;
  unregisterForge: () => void;
}

function createPollHarness(options?: {
  remoteUrl?: string;
  gitCommonDir?: string;
  genericForge?: boolean;
}): PollHarness {
  const remoteUrl = options?.remoteUrl ?? "https://github.com/acme/repo.git";
  const gitCommonDir = options?.gitCommonDir ?? path.join(QUIET_CWD, ".git");
  const runGitFetch = vi.fn(async () => ({ changes: [], error: null }));
  const retain = vi.fn(() => ({ unsubscribe: vi.fn() }));
  const getCurrentPullRequestStatus = vi.fn(async () => ({
    url: "https://forge-poll.test/acme/repo/pull/1",
    title: "MR",
    state: "open" as const,
    baseRefName: "main",
    headRefName: "feature",
    isMerged: false,
    checksStatus: "passing" as const,
  }));
  const getPullRequestStatus = vi.fn(async () => ({
    status: {
      url: "https://github.com/acme/repo/pull/1",
      title: "PR",
      state: "open" as const,
      baseRefName: "main",
      headRefName: "feature",
      isMerged: false,
    },
    authState: "authenticated" as const,
    featuresEnabled: true,
    githubFeaturesEnabled: true,
  }));
  const forge = {
    retainCurrentPullRequestStatusPoll: options?.genericForge ? undefined : retain,
    getCurrentPullRequestStatus,
    isAuthenticated: vi.fn(async () => true),
    invalidate: vi.fn(),
    authProbeCanThrow: false,
  };
  let unregisterForge = () => {};
  if (options?.genericForge) {
    unregisterForge = defaultForgeRegistry.register("git-remote-poll-forge", {
      createService: () => forge as unknown as ForgeService,
      matchesHost: (host) => host === "forge-poll.test",
    });
  }
  const service = new WorkspaceGitServiceImpl({
    logger: createLogger() as never,
    paseoHome: "/tmp/paseo-test",
    deps: {
      subscribe: vi.fn(async () => ({
        updateIgnore: vi.fn(async () => {}),
        unsubscribe: vi.fn(async () => {}),
      })),
      getCheckoutSnapshotFacts: vi.fn(async (cwd: string) =>
        checkoutFacts(cwd, remoteUrl, gitCommonDir),
      ),
      getCheckoutRefDerivedState: vi.fn(async (_cwd, facts, current) => ({
        ...current,
        upstreamStatus: facts.upstreamStatus,
      })),
      getCheckoutStatus: vi.fn(async (cwd: string) => checkoutStatus(cwd, remoteUrl)),
      getCheckoutShortstat: vi.fn(async () => ({ additions: 0, deletions: 0 })),
      getCheckoutWorktreeState: vi.fn(async () => ({
        isDirty: false,
        diffStat: { additions: 0, deletions: 0 },
      })),
      getPullRequestStatus,
      resolveAbsoluteGitDir: vi.fn(async (cwd: string) => path.join(cwd, ".git")),
      hasOriginRemote: vi.fn(async () => true),
      runGitFetch,
      runGitCommand: vi.fn(async (_args: string[], command: { cwd: string }) => ({
        stdout: `${command.cwd}\n`,
        stderr: "",
        truncated: false,
        exitCode: 0,
        signal: null,
      })),
      getWorkspaceGitSelfHealPhaseMs: () => 30_000,
      createWatcherLivenessCanary: vi.fn(() => ({
        path: "",
        filterEvents: (events: unknown[]) => events,
        verify: vi.fn(async () => {}),
      })),
      ...(options?.genericForge
        ? {}
        : { forgeOverrides: { github: forge as unknown as ForgeService } }),
    },
  });
  // Bound to an empty set. A service the gate has not touched still fetches.
  service.applyRemotePoll(new Set());
  return {
    service,
    runGitFetch,
    retain,
    getPullRequestStatus,
    getCurrentPullRequestStatus,
    unregisterForge,
  };
}

async function settled(): Promise<void> {
  await vi.waitFor(() => {
    expect(true).toBe(true);
  });
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe("remote poll arming", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a quiet registered workspace does not fetch, retain a PR poll, or read the forge, including after 180s", async () => {
    const harness = createPollHarness();
    try {
      harness.service.registerWorkspace({ cwd: QUIET_CWD }, vi.fn());
      await settled();
      await vi.advanceTimersByTimeAsync(180_000);
      await settled();

      expect(harness.runGitFetch).not.toHaveBeenCalled();
      expect(harness.retain).not.toHaveBeenCalled();
      expect(harness.getPullRequestStatus).not.toHaveBeenCalled();
    } finally {
      await harness.service.dispose();
    }
  });

  test("applying the same admitted set twice does not fetch a second time", async () => {
    const harness = createPollHarness();
    const admitted = new Set([QUIET_CWD]);
    try {
      harness.service.applyRemotePoll(admitted);
      harness.service.registerWorkspace({ cwd: QUIET_CWD }, vi.fn());
      await vi.waitFor(() => {
        expect(harness.runGitFetch).toHaveBeenCalledTimes(1);
      });

      harness.service.applyRemotePoll(new Set([QUIET_CWD]));
      await settled();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(harness.runGitFetch).toHaveBeenCalledTimes(1);
    } finally {
      await harness.service.dispose();
    }
  });

  test("a directory that enters the set fetches and retains without waiting out 180s or 120s", async () => {
    const harness = createPollHarness({
      remoteUrl: "https://forge-poll.test/acme/repo.git",
      genericForge: true,
    });
    try {
      harness.service.registerWorkspace({ cwd: QUIET_CWD }, vi.fn());
      await settled();
      expect(harness.runGitFetch).not.toHaveBeenCalled();
      expect(harness.getCurrentPullRequestStatus).not.toHaveBeenCalled();

      harness.service.applyRemotePoll(new Set([QUIET_CWD]));
      // Observation setup does real async IO, so wait on the effect rather than microtasks.
      await vi.waitFor(() => {
        expect(harness.runGitFetch).toHaveBeenCalledTimes(1);
        expect(harness.getCurrentPullRequestStatus).toHaveBeenCalled();
      });
    } finally {
      harness.unregisterForge();
      await harness.service.dispose();
    }
  });

  test("two worktrees of one repo share one fetch timer, and the last member to leave clears it", async () => {
    const harness = createPollHarness({ gitCommonDir: SHARED_GIT_DIR });
    try {
      harness.service.applyRemotePoll(new Set([QUIET_CWD, SIBLING_CWD]));
      harness.service.registerWorkspace({ cwd: QUIET_CWD }, vi.fn());
      harness.service.registerWorkspace({ cwd: SIBLING_CWD }, vi.fn());
      await vi.waitFor(() => {
        expect(harness.runGitFetch).toHaveBeenCalledTimes(1);
      });

      harness.service.applyRemotePoll(new Set([SIBLING_CWD]));
      await vi.advanceTimersByTimeAsync(180_000);
      await settled();
      expect(harness.runGitFetch).toHaveBeenCalledTimes(2);

      harness.service.applyRemotePoll(new Set());
      await vi.advanceTimersByTimeAsync(180_000);
      await settled();
      expect(harness.runGitFetch).toHaveBeenCalledTimes(2);
    } finally {
      await harness.service.dispose();
    }
  });
});

interface WorkspaceRow {
  workspaceId: string;
  cwd: string;
  archivedAt: string | null;
}

interface LiveAgent {
  id: string;
  cwd: string;
  workspaceId?: string;
  updatedAt: Date;
}

function storedAgent(fields: {
  id: string;
  updatedAt: string;
  cwd: string;
  workspaceId?: string;
  archivedAt?: string | null;
}): StoredAgentRecord {
  return {
    id: fields.id,
    provider: "claude",
    cwd: fields.cwd,
    workspaceId: fields.workspaceId,
    createdAt: fields.updatedAt,
    updatedAt: fields.updatedAt,
    labels: {},
    lastStatus: "idle",
    archivedAt: fields.archivedAt ?? null,
  } as StoredAgentRecord;
}

function createGate(now: () => number): {
  harness: PollHarness;
  gate: GitRemotePollGate;
  workspaces: WorkspaceRow[];
  records: StoredAgentRecord[];
  agents: LiveAgent[];
  emit: (agent: LiveAgent) => void;
  applyCount: () => number;
} {
  const harness = createPollHarness();
  let applyCount = 0;
  const applyRemotePoll = harness.service.applyRemotePoll.bind(harness.service);
  harness.service.applyRemotePoll = (cwds) => {
    applyCount += 1;
    applyRemotePoll(cwds);
  };
  const workspaces: WorkspaceRow[] = [];
  const records: StoredAgentRecord[] = [];
  const agents: LiveAgent[] = [];
  const listeners: Array<(event: { type: "agent_state"; agent: LiveAgent }) => void> = [];
  const gate = createGitRemotePollGate({
    workspaceGitService: harness.service,
    workspaceRegistry: {
      list: async () => workspaces,
      subscribeToMutations: () => () => {},
    },
    agentStorage: { list: async () => records },
    agentManager: {
      listAgents: () => agents,
      subscribe: (callback) => {
        listeners.push(callback);
        return () => {
          const index = listeners.indexOf(callback);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
    },
    now,
    logger: createLogger() as never,
  });
  return {
    harness,
    gate,
    workspaces,
    records,
    agents,
    emit: (agent) => {
      for (const listener of listeners) listener({ type: "agent_state", agent });
    },
    applyCount: () => applyCount,
  };
}

describe("git remote poll gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("start fetches a stored updatedAt one hour old and skips seven hours, without writing the test clock into the record", async () => {
    const recent = createGate(() => Date.now());
    const recentUpdatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recentRecord = storedAgent({
      id: "recent",
      updatedAt: recentUpdatedAt,
      cwd: path.join(QUIET_CWD, "packages"),
      workspaceId: "w1",
    });
    recent.workspaces.push({ workspaceId: "w1", cwd: QUIET_CWD, archivedAt: null });
    recent.records.push(recentRecord);
    recent.harness.service.registerWorkspace({ cwd: QUIET_CWD }, vi.fn());
    await settled();
    expect(recent.harness.runGitFetch).not.toHaveBeenCalled();

    await recent.gate.start(recent.records);
    await vi.waitFor(() => {
      expect(recent.harness.runGitFetch).toHaveBeenCalledTimes(1);
    });
    expect(recentRecord.updatedAt).toBe(recentUpdatedAt);
    recent.gate.stop();
    await recent.harness.service.dispose();

    const stale = createGate(() => Date.now());
    const staleUpdatedAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const staleRecord = storedAgent({
      id: "stale",
      updatedAt: staleUpdatedAt,
      cwd: QUIET_CWD,
      workspaceId: "w1",
    });
    stale.workspaces.push({ workspaceId: "w1", cwd: QUIET_CWD, archivedAt: null });
    stale.records.push(staleRecord);
    stale.harness.service.registerWorkspace({ cwd: QUIET_CWD }, vi.fn());
    await settled();
    await stale.gate.start(stale.records);
    await settled();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(stale.harness.runGitFetch).not.toHaveBeenCalled();
    expect(staleRecord.updatedAt).toBe(staleUpdatedAt);
    stale.gate.stop();
    await stale.harness.service.dispose();
  });

  test("an open directory with a stale agent is fetched, and an archived workspace is not even when a client reports it open", async () => {
    const open = createGate(() => Date.now());
    open.workspaces.push({ workspaceId: "w1", cwd: QUIET_CWD, archivedAt: null });
    open.records.push(
      storedAgent({
        id: "stale",
        updatedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
        cwd: QUIET_CWD,
        workspaceId: "w1",
      }),
    );
    open.harness.service.registerWorkspace({ cwd: QUIET_CWD }, vi.fn());
    await settled();
    await open.gate.start(open.records);
    open.gate.setClientOpenWorkspace("client-1", "w1");
    await vi.waitFor(() => {
      expect(open.harness.runGitFetch).toHaveBeenCalledTimes(1);
    });
    open.gate.stop();
    await open.harness.service.dispose();

    const archived = createGate(() => Date.now());
    archived.workspaces.push({
      workspaceId: "w1",
      cwd: QUIET_CWD,
      archivedAt: "2026-06-01T00:00:00.000Z",
    });
    archived.harness.service.registerWorkspace({ cwd: QUIET_CWD }, vi.fn());
    await settled();
    await archived.gate.start(archived.records);
    archived.gate.setClientOpenWorkspace("client-1", "w1");
    await settled();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(archived.harness.runGitFetch).not.toHaveBeenCalled();
    archived.gate.stop();
    await archived.harness.service.dispose();
  });

  test("a prompt on a quiet directory fetches without waiting 180s, and a second heartbeat with the same workspace does not apply again", async () => {
    const fixture = createGate(() => Date.now());
    fixture.workspaces.push({ workspaceId: "w1", cwd: QUIET_CWD, archivedAt: null });
    fixture.records.push(
      storedAgent({
        id: "quiet",
        updatedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
        cwd: path.join(QUIET_CWD, "packages"),
        workspaceId: "w1",
      }),
    );
    fixture.harness.service.registerWorkspace({ cwd: QUIET_CWD }, vi.fn());
    await settled();
    await fixture.gate.start(fixture.records);
    await settled();
    expect(fixture.harness.runGitFetch).not.toHaveBeenCalled();

    const appliesAfterStart = fixture.applyCount();
    fixture.gate.setClientOpenWorkspace("client-1", "missing");
    fixture.gate.setClientOpenWorkspace("client-1", "missing");
    expect(fixture.applyCount()).toBe(appliesAfterStart + 1);
    expect(fixture.harness.runGitFetch).not.toHaveBeenCalled();

    fixture.agents.push({
      id: "quiet",
      cwd: path.join(QUIET_CWD, "packages"),
      workspaceId: "w1",
      updatedAt: new Date(Date.now()),
    });
    fixture.emit(fixture.agents[0]!);
    await vi.waitFor(() => {
      expect(fixture.harness.runGitFetch).toHaveBeenCalledTimes(1);
    });

    const appliesAfterPrompt = fixture.applyCount();
    fixture.emit({
      ...fixture.agents[0]!,
      updatedAt: new Date(Date.now() + 1),
    });
    expect(fixture.applyCount()).toBe(appliesAfterPrompt);
    fixture.gate.stop();
    await fixture.harness.service.dispose();
  });

  test("a one-hour-old clock stops fetching once it reaches 6 hours", async () => {
    const fixture = createGate(() => Date.now());
    const updatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    fixture.workspaces.push({ workspaceId: "w1", cwd: QUIET_CWD, archivedAt: null });
    fixture.records.push(
      storedAgent({
        id: "recent",
        updatedAt,
        cwd: QUIET_CWD,
        workspaceId: "w1",
      }),
    );
    fixture.harness.service.registerWorkspace({ cwd: QUIET_CWD }, vi.fn());
    await settled();
    await fixture.gate.start(fixture.records);
    await vi.waitFor(() => {
      expect(fixture.harness.runGitFetch).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(GIT_REMOTE_POLL_QUIET_MS - 60 * 60 * 1000);
    await settled();
    const fetchesAtQuiet = fixture.harness.runGitFetch.mock.calls.length;
    expect(fetchesAtQuiet).toBeGreaterThan(1);

    await vi.advanceTimersByTimeAsync(180_000);
    await settled();
    expect(fixture.harness.runGitFetch).toHaveBeenCalledTimes(fetchesAtQuiet);
    expect(fixture.records[0]?.updatedAt).toBe(updatedAt);

    fixture.gate.stop();
    await fixture.harness.service.dispose();
  });

  test("an open workspace keeps polling past 6 hours, and forgetClient stops it", async () => {
    const fixture = createGate(() => Date.now());
    fixture.workspaces.push({ workspaceId: "w1", cwd: QUIET_CWD, archivedAt: null });
    fixture.records.push(
      storedAgent({
        id: "stale",
        updatedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
        cwd: QUIET_CWD,
        workspaceId: "w1",
      }),
    );
    fixture.harness.service.registerWorkspace({ cwd: QUIET_CWD }, vi.fn());
    await settled();
    await fixture.gate.start(fixture.records);
    fixture.gate.setClientOpenWorkspace("client-1", "w1");
    await vi.waitFor(() => {
      expect(fixture.harness.runGitFetch).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(GIT_REMOTE_POLL_QUIET_MS);
    await settled();
    const fetchesWhileOpen = fixture.harness.runGitFetch.mock.calls.length;
    expect(fetchesWhileOpen).toBeGreaterThan(1);

    fixture.gate.forgetClient("client-1");
    await settled();
    await vi.advanceTimersByTimeAsync(180_000);
    await settled();
    expect(fixture.harness.runGitFetch).toHaveBeenCalledTimes(fetchesWhileOpen);

    fixture.gate.stop();
    await fixture.harness.service.dispose();
  });
});
