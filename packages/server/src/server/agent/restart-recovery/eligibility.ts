import type { StoredAgentRecord } from "../agent-storage.js";

export interface RestartResumeFacts {
  record: StoredAgentRecord;
  /** The live agent is running a cache warm-up ping right now, which is daemon traffic, not user work. */
  liveWarmPing: boolean;
  workspaceArchived: boolean;
}

/**
 * Whether the daemon may resume a stored agent on the next start. A warm-up ping is not work the
 * user left running. An expired prompt cache does not count: the stop interrupted a turn, which
 * would have written the cache again on its next request anyway, and a short window runs out
 * while the daemon restarts.
 */
export function isRestartResumeEligible(facts: RestartResumeFacts): boolean {
  if (!facts.record.persistence?.sessionId) return false;
  if (facts.liveWarmPing) return false;
  return !facts.workspaceArchived;
}
