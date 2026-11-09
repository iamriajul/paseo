import { useSessionStore } from "@/stores/session-store";
import { formatCountdownClock } from "@/usage/format";
import { useHostFeature } from "@/runtime/host-features";
import { useCountdownFlash } from "./countdown-urgency";
import {
  resolvePromptCacheView,
  usePromptCacheAgent,
  useSecondClock,
  type PromptCacheView,
} from "./use-prompt-cache";

export interface WorkspaceCacheWarm {
  /**
   * The workspace's active agent's countdown: to its next warm-up, or, once the cap is spent, to
   * the cache expiring. Null when nothing is counting down: warm-up off, Automatic window, paused
   * after the idle-cap compaction, the cache already expired, or, on a host that cannot warm
   * through a fork, a turn running or a question or permission pending. The row ticks only while
   * it shows one.
   */
  text: string | null;
  /** The countdown runs to the cache expiring, the warm-up cap being spent. */
  capped: boolean;
  /** The countdown draws in the warning colour this second, by the pill's rule (`useCountdownFlash`). */
  flash: boolean;
  /** The active agent's avoidable cache misses this session. */
  misses: number;
}

function resolveCountdownMs(view: PromptCacheView): number | null {
  const plan = view.warmup?.plan;
  if (plan?.kind === "next-ping") return plan.remainingMs;
  if (plan?.kind === "capped" && view.status.kind === "warm") return view.status.remainingMs;
  return null;
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
    resolveCountdownMs(resolvePromptCacheView(agent, Date.now(), { forkWarm })) !== null;
  const now = useSecondClock(counting);
  const view = resolvePromptCacheView(agent, now, { forkWarm });
  const countdownMs = resolveCountdownMs(view);
  const flash = useCountdownFlash(countdownMs === null ? null : view.warmup, now);
  return {
    text: countdownMs === null ? null : formatCountdownClock(countdownMs),
    capped: countdownMs !== null && view.warmup?.plan.kind === "capped",
    flash,
    misses: view.isClaude ? view.misses : 0,
  };
}
