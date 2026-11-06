import { useSessionStore } from "@/stores/session-store";
import { formatCountdownClock } from "@/usage/format";
import { useHostFeature } from "@/runtime/host-features";
import { resolvePromptCacheView, usePromptCacheAgent, useSecondClock } from "./use-prompt-cache";

export interface WorkspaceCacheWarm {
  /**
   * The countdown to the next warm-up of the workspace's active agent, or null when nothing is
   * counting down: warm-up off, Automatic window, the cap reached, paused after the idle-cap
   * compaction, the cache already expired, or,
   * on a host that cannot warm through a fork, a turn running or a question or permission pending.
   * The row ticks only while it shows one.
   */
  text: string | null;
  /** The active agent's avoidable cache misses this session. */
  misses: number;
}

export function useWorkspaceCacheWarm(input: {
  serverId: string;
  workspaceId: string;
}): WorkspaceCacheWarm {
  "use no memo";
  const agentId = useSessionStore(
    (state) =>
      state.sessions[input.serverId]?.workspaceAgentActivity.get(input.workspaceId)?.agentId ??
      null,
  );
  const agent = usePromptCacheAgent(input.serverId, agentId ?? "");
  const forkWarm = useHostFeature(input.serverId, "cacheWarmFork");
  const counting =
    resolvePromptCacheView(agent, Date.now(), { forkWarm }).warmup?.plan.kind === "next-ping";
  const now = useSecondClock(counting);
  const view = resolvePromptCacheView(agent, now, { forkWarm });
  const plan = view.warmup?.plan;
  return {
    text: plan?.kind === "next-ping" ? formatCountdownClock(plan.remainingMs) : null,
    misses: view.isClaude ? view.misses : 0,
  };
}
