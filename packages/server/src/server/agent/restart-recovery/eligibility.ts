import type { StoredAgentRecord } from "../agent-storage.js";
import { shouldSkipWakeForExpiredCache } from "../prompt-cache-expiry.js";

export interface RestartResumeFacts {
  record: StoredAgentRecord;
  /** The live agent is running a cache warm-up ping right now, which is daemon traffic, not user work. */
  liveWarmPing: boolean;
  workspaceArchived: boolean;
  nowMs: number;
}

/**
 * Whether the daemon may resume a stored agent on the next start. These rules hold whatever the
 * cache-warming settings say: a warm-up ping is not work the user left running, and an expired
 * prompt cache makes a resume write the whole context again at full price.
 */
export function isRestartResumeEligible(facts: RestartResumeFacts): boolean {
  if (!facts.record.persistence?.sessionId) return false;
  if (facts.liveWarmPing) return false;
  if (facts.workspaceArchived) return false;
  return !shouldSkipWakeForExpiredCache({
    agent: facts.record,
    policy: "always",
    nowMs: facts.nowMs,
  });
}
