import { useSessionStore } from "@/stores/session-store";
import { formatCountdownClock } from "@/usage/format";
import { resolvePromptCacheView, usePromptCacheAgent, useSecondClock } from "./use-prompt-cache";

/**
 * The countdown to the next warm-up of a workspace's active agent, or null when nothing is
 * counting down: warm-up off, Automatic window, a turn running, a question or permission
 * pending, the cap reached, or the cache already expired. The row ticks only while it shows one.
 */
export function useWorkspaceCacheWarmText(input: {
  serverId: string;
  workspaceId: string;
}): string | null {
  "use no memo";
  const agentId = useSessionStore(
    (state) =>
      state.sessions[input.serverId]?.workspaceAgentActivity.get(input.workspaceId)?.agentId ??
      null,
  );
  const agent = usePromptCacheAgent(input.serverId, agentId ?? "");
  const counting = resolvePromptCacheView(agent, Date.now()).warmup?.plan.kind === "next-ping";
  const now = useSecondClock(counting);
  const plan = resolvePromptCacheView(agent, now).warmup?.plan;
  return plan?.kind === "next-ping" ? formatCountdownClock(plan.remainingMs) : null;
}
