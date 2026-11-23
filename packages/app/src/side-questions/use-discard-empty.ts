import { useEffect } from "react";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useSessionStore } from "@/stores/session-store";

const DISCARD_DELAY_MS = 1_000;
/** Panes showing each side question right now: a remount or a second pane must not discard it. */
const openPanes = new Map<string, number>();

/**
 * Archives a side question whose pane closed before anything was sent. An empty one has nothing to
 * list or resume. The check waits a moment and counts open panes, so a remount does not discard it.
 */
export function useDiscardEmptySideQuestion(input: {
  serverId: string;
  sideAgentId: string;
}): void {
  const { serverId, sideAgentId } = input;
  const { archiveAgent } = useArchiveAgent();
  useEffect(() => {
    openPanes.set(sideAgentId, (openPanes.get(sideAgentId) ?? 0) + 1);
    return () => {
      openPanes.set(sideAgentId, (openPanes.get(sideAgentId) ?? 1) - 1);
      setTimeout(() => {
        if ((openPanes.get(sideAgentId) ?? 0) > 0) return;
        openPanes.delete(sideAgentId);
        const session = useSessionStore.getState().sessions[serverId];
        const agent = session?.agents.get(sideAgentId);
        if (!agent || agent.archivedAt) return;
        const items = [
          ...(session?.agentStreamTail.get(sideAgentId) ?? []),
          ...(session?.agentStreamHead.get(sideAgentId) ?? []),
        ];
        const asked = items.some((item) => item.kind === "user_message") || agent.promptCache;
        if (!asked) void archiveAgent({ serverId, agentId: sideAgentId });
      }, DISCARD_DELAY_MS);
    };
  }, [archiveAgent, serverId, sideAgentId]);
}
