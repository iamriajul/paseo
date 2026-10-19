import { resolve } from "node:path";
import type { Logger } from "pino";

import type { StoredAgentRecord } from "../agent/agent-storage.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import {
  nextRemotePollQuietDeadlineMs,
  selectRemotePollCwds,
  type RemotePollAgentClock,
  type RemotePollInput,
} from "./select-remote-poll-cwds.js";

export interface GitRemotePollClientPin {
  setClientOpenWorkspace(clientId: string, workspaceId: string | null): void;
  forgetClient(clientId: string): void;
}

export interface GitRemotePollGate extends GitRemotePollClientPin {
  start(records: readonly StoredAgentRecord[]): Promise<void>;
  stop(): void;
}

interface WorkspaceDirectoryRecord {
  workspaceId: string;
  cwd: string;
  archivedAt?: string | null;
}

interface LiveAgentClock {
  id: string;
  cwd: string;
  workspaceId?: string;
  updatedAt: Date;
}

interface JoinedAgentClock {
  cwd: string;
  workspaceId?: string;
  updatedAtMs: number;
  archived: boolean;
}

export function createGitRemotePollGate(deps: {
  workspaceGitService: Pick<WorkspaceGitService, "applyRemotePoll">;
  workspaceRegistry: {
    list(): Promise<readonly WorkspaceDirectoryRecord[]>;
    subscribeToMutations?(
      listener: (mutation: {
        workspaceId: string;
        workspace: WorkspaceDirectoryRecord | null;
      }) => void,
    ): () => void;
  };
  agentStorage: { list(): Promise<readonly StoredAgentRecord[]> };
  agentManager: {
    listAgents(): readonly LiveAgentClock[];
    subscribe(
      callback: (event: { type: "agent_state"; agent: LiveAgentClock }) => void,
    ): () => void;
  };
  now: () => number;
  logger: Logger;
}): GitRemotePollGate {
  let storageSnapshot: readonly StoredAgentRecord[] = [];
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeAgents: (() => void) | null = null;
  let unsubscribeWorkspaces: (() => void) | null = null;
  const directoriesById = new Map<string, string>();
  const pins = new Map<string, string>();
  let applied = new Set<string>();

  function rememberWorkspace(record: WorkspaceDirectoryRecord | null, workspaceId: string): void {
    if (!record || record.archivedAt) {
      directoriesById.delete(workspaceId);
      return;
    }
    directoriesById.set(workspaceId, resolve(record.cwd));
  }

  function directoryFor(agent: { cwd: string; workspaceId?: string }): string | null {
    if (agent.workspaceId) return directoriesById.get(agent.workspaceId) ?? null;
    const cwd = resolve(agent.cwd);
    for (const directory of directoriesById.values()) {
      if (directory === cwd) return directory;
    }
    return null;
  }

  function openCwds(): Set<string> {
    const open = new Set<string>();
    for (const workspaceId of pins.values()) {
      const cwd = directoriesById.get(workspaceId);
      if (cwd) open.add(cwd);
    }
    return open;
  }

  function joinedClocks(): RemotePollAgentClock[] {
    const byId = new Map<string, JoinedAgentClock>();
    for (const record of storageSnapshot) {
      byId.set(record.id, {
        cwd: record.cwd,
        workspaceId: record.workspaceId,
        updatedAtMs: Date.parse(record.updatedAt),
        archived: Boolean(record.archivedAt),
      });
    }
    for (const live of deps.agentManager.listAgents()) {
      const previous = byId.get(live.id);
      byId.set(live.id, {
        cwd: live.cwd,
        workspaceId: live.workspaceId ?? previous?.workspaceId,
        updatedAtMs: live.updatedAt.getTime(),
        archived: false,
      });
    }
    const clocks: RemotePollAgentClock[] = [];
    for (const agent of byId.values()) {
      const cwd = directoryFor(agent);
      if (!cwd) continue;
      clocks.push({ cwd, updatedAtMs: agent.updatedAtMs, archived: agent.archived });
    }
    return clocks;
  }

  function pollInput(): RemotePollInput {
    return { nowMs: deps.now(), agents: joinedClocks(), openCwds: openCwds() };
  }

  function apply(): void {
    const input = pollInput();
    const next = selectRemotePollCwds(input);
    deps.workspaceGitService.applyRemotePoll(next);
    applied = new Set(next);
    arm(input);
  }

  function arm(input: RemotePollInput): void {
    if (quietTimer) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
    const deadline = nextRemotePollQuietDeadlineMs(input);
    if (deadline === null) return;
    const delay = Math.max(1, deadline - deps.now());
    quietTimer = setTimeout(() => {
      quietTimer = null;
      void onQuiet();
    }, delay);
  }

  async function onQuiet(): Promise<void> {
    try {
      storageSnapshot = await deps.agentStorage.list();
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to reload agent records for remote git poll");
    }
    apply();
  }

  async function reloadDirectories(): Promise<void> {
    directoriesById.clear();
    for (const record of await deps.workspaceRegistry.list()) {
      rememberWorkspace(record, record.workspaceId);
    }
  }

  return {
    async start(records) {
      storageSnapshot = records;
      await reloadDirectories();
      unsubscribeAgents?.();
      unsubscribeAgents = deps.agentManager.subscribe((event) => {
        if (event.type !== "agent_state") return;
        const cwd = directoryFor(event.agent);
        if (!cwd || applied.has(cwd)) return;
        apply();
      });
      unsubscribeWorkspaces?.();
      unsubscribeWorkspaces =
        deps.workspaceRegistry.subscribeToMutations?.((mutation) => {
          rememberWorkspace(mutation.workspace, mutation.workspaceId);
          apply();
        }) ?? null;
      apply();
    },
    setClientOpenWorkspace(clientId, workspaceId) {
      const previous = pins.get(clientId) ?? null;
      if (previous === workspaceId) return;
      if (workspaceId === null) pins.delete(clientId);
      else pins.set(clientId, workspaceId);
      apply();
    },
    forgetClient(clientId) {
      if (!pins.has(clientId)) return;
      pins.delete(clientId);
      apply();
    },
    stop() {
      if (quietTimer) {
        clearTimeout(quietTimer);
        quietTimer = null;
      }
      unsubscribeAgents?.();
      unsubscribeAgents = null;
      unsubscribeWorkspaces?.();
      unsubscribeWorkspaces = null;
    },
  };
}
