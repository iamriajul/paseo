import { getSideQuestionSourceId } from "@getpaseo/protocol/agent-labels";
import { useSessionStore } from "@/stores/session-store";

/** The chat this agent is a side question of, or null when it is an ordinary agent. */
export function useSideQuestionSourceId(serverId: string, agentId: string): string | null {
  return useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return getSideQuestionSourceId(agent?.labels);
  });
}
