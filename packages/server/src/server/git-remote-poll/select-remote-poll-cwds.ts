/**
 * Quiet means this age or older. Exactly this age is out, so a timer that
 * fires at the deadline and this comparison cannot disagree.
 */
export const GIT_REMOTE_POLL_QUIET_MS = 6 * 60 * 60 * 1000;

/**
 * One agent clock, already joined to a workspace directory.
 * `cwd` is resolved and is the directory the git service keys by.
 * `updatedAtMs` is the agent `updatedAt`. Never `lastActivityAt`,
 * `activityAt`, `statusEnteredAt`, or a terminal `changedAt`.
 */
export interface RemotePollAgentClock {
  readonly cwd: string;
  readonly updatedAtMs: number;
  readonly archived: boolean;
}

export interface RemotePollInput {
  readonly nowMs: number;
  readonly agents: readonly RemotePollAgentClock[];
  /** Workspace directories some connected client currently has open. */
  readonly openCwds: ReadonlySet<string>;
}

/** Directories whose remote poll is on. */
export type RemotePollSet = ReadonlySet<string>;

export function selectRemotePollCwds(input: RemotePollInput): RemotePollSet {
  const selected = new Set<string>(input.openCwds);
  for (const [cwd, updatedAtMs] of newestAgentUpdatedAtMs(input.agents)) {
    if (input.nowMs - updatedAtMs < GIT_REMOTE_POLL_QUIET_MS) {
      selected.add(cwd);
    }
  }
  return selected;
}

/**
 * When the soonest non-open member goes quiet.
 * Null when every member is open, or the set is empty.
 */
export function nextRemotePollQuietDeadlineMs(input: RemotePollInput): number | null {
  let soonest: number | null = null;
  for (const [cwd, updatedAtMs] of newestAgentUpdatedAtMs(input.agents)) {
    if (input.openCwds.has(cwd)) continue;
    if (input.nowMs - updatedAtMs >= GIT_REMOTE_POLL_QUIET_MS) continue;
    const deadline = updatedAtMs + GIT_REMOTE_POLL_QUIET_MS;
    if (soonest === null || deadline < soonest) soonest = deadline;
  }
  return soonest;
}

function newestAgentUpdatedAtMs(
  agents: readonly RemotePollAgentClock[],
): ReadonlyMap<string, number> {
  const newest = new Map<string, number>();
  for (const agent of agents) {
    if (agent.archived || !Number.isFinite(agent.updatedAtMs)) continue;
    const current = newest.get(agent.cwd);
    if (current === undefined || agent.updatedAtMs > current) {
      newest.set(agent.cwd, agent.updatedAtMs);
    }
  }
  return newest;
}
