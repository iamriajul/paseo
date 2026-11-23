import { useSessionStore } from "@/stores/session-store";
import { formatCountdownClock } from "@/usage/format";
import { useHostFeature } from "@/runtime/host-features";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
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
   * through a fork, a turn running or a question or permission pending. With the sidebar's
   * "Warm cache only" filter on, any of those whose cache is still warm counts down to it
   * expiring instead, so every row the filter keeps says how long it stays. The row ticks only
   * while it shows one.
   */
  text: string | null;
  /** The countdown runs to the cache expiring: the warm-up cap is spent, or no warm-up runs. */
  capped: boolean;
  /** The countdown draws in the warning colour this second, by the pill's rule (`useCountdownFlash`). */
  flash: boolean;
  /** The active agent's avoidable cache misses this session. */
  misses: number;
}

interface Countdown {
  remainingMs: number;
  toExpiry: boolean;
}

function resolveCountdown(view: PromptCacheView, untilExpiry: boolean): Countdown | null {
  const plan = view.warmup?.plan;
  if (plan?.kind === "next-ping") return { remainingMs: plan.remainingMs, toExpiry: false };
  if (plan?.kind === "capped" && view.status.kind === "warm") {
    return { remainingMs: view.status.remainingMs, toExpiry: true };
  }
  if (!untilExpiry) return null;
  const { status } = view;
  const remainingMs =
    status.kind === "warm" ||
    status.kind === "busy" ||
    status.kind === "awaiting-question" ||
    status.kind === "awaiting-permission"
      ? status.remainingMs
      : null;
  return remainingMs !== null && remainingMs > 0 ? { remainingMs, toExpiry: true } : null;
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
  const untilExpiry = useSidebarViewStore((state) => state.warmCacheOnly);
  const counting =
    resolveCountdown(resolvePromptCacheView(agent, Date.now(), { forkWarm }), untilExpiry) !== null;
  const now = useSecondClock(counting);
  const view = resolvePromptCacheView(agent, now, { forkWarm });
  const countdown = resolveCountdown(view, untilExpiry);
  const flash = useCountdownFlash(countdown === null ? null : view.warmup, now);
  return {
    text: countdown === null ? null : formatCountdownClock(countdown.remainingMs),
    capped: countdown?.toExpiry === true,
    flash,
    misses: view.isClaude ? view.misses : 0,
  };
}
