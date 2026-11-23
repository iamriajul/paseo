import { useEffect, useState } from "react";
import type { SideQuestionCacheEstimate } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";

const REFRESH_MS = 20_000;

/**
 * What the next question will do to the prompt cache, asked of the daemon, which holds the
 * request journal. It refreshes while the pane is open and after each answer, because a cache
 * that was warm when the pane opened can pass its window while the user types.
 */
export function useSideQuestionEstimate(input: {
  serverId: string;
  sideAgentId: string;
  /** False in a chat that is not a side question: nothing is asked. */
  enabled: boolean;
}): SideQuestionCacheEstimate | null {
  const { serverId, sideAgentId, enabled } = input;
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  // Changes when an answer lands, so the estimate is asked again.
  const answeredAt = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(sideAgentId)?.promptCache?.lastRequest.at,
  );
  const [estimate, setEstimate] = useState<SideQuestionCacheEstimate | null>(null);
  useEffect(() => {
    if (!client || !enabled) return undefined;
    let cancelled = false;
    const ask = async () => {
      try {
        const response = await client.getSideQuestionEstimate(sideAgentId);
        if (!cancelled) setEstimate(response.estimate);
      } catch {
        if (!cancelled) setEstimate(null);
      }
    };
    void ask();
    const timer = setInterval(() => void ask(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [answeredAt, client, enabled, sideAgentId]);
  return estimate;
}
