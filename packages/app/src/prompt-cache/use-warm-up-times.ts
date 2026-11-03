import { useEffect, useMemo, useState } from "react";
import type { PromptCacheHistoryEntry } from "@getpaseo/protocol/agent-cache-warm";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { usePromptCacheAgent } from "./use-prompt-cache";

const EMPTY_TIMES: readonly number[] = [];

function warmUpTimesOf(entries: readonly PromptCacheHistoryEntry[] | undefined): number[] {
  if (!entries) return [];
  return entries.filter((entry) => entry.kind === "warm-up").map((entry) => Date.parse(entry.at));
}

function mergeTimes(known: readonly number[], incoming: readonly number[]): readonly number[] {
  const seen = new Set(known);
  const added = incoming.filter((at) => Number.isFinite(at) && !seen.has(at));
  if (added.length === 0) return known;
  return [...known, ...added].sort((a, b) => a - b);
}

/**
 * Every recorded warm-up of the agent, ascending. The snapshot carries only the latest requests,
 * so older warm-ups are read once from the daemon's journal, and only when the snapshot does not
 * already hold all of them. Times seen stay known while the chat is open, so a warm-up that
 * rolls off the snapshot keeps its place.
 */
export function useWarmUpTimes(serverId: string, agentId: string): readonly number[] {
  const agent = usePromptCacheAgent(serverId, agentId);
  const client = useHostRuntimeClient(serverId);
  const journalSupported = useHostFeature(serverId, "promptCacheInsights");
  const snapshotHistory = agent?.promptCache?.history;
  const snapshotTimes = useMemo(() => warmUpTimesOf(snapshotHistory), [snapshotHistory]);
  const totalWarmUps = agent?.totalWarmPings ?? 0;
  const journal = useFetchQuery<number[], Error>({
    queryKey: ["promptCacheWarmUpTimes", serverId, agentId],
    queryFn: async () => {
      if (!client) return [];
      const payload = await client.getPromptCacheHistory({ agentId });
      if (payload.error) throw new Error(payload.error);
      return warmUpTimesOf(payload.requests);
    },
    enabled: Boolean(client && journalSupported && totalWarmUps > snapshotTimes.length),
    retry: false,
    dataShape: "value",
    // Recorded warm-ups never change; later ones arrive on the snapshot.
    immutableWhen: () => true,
  });

  const [known, setKnown] = useState<{ agentId: string; times: readonly number[] }>({
    agentId,
    times: EMPTY_TIMES,
  });
  const journalTimes = journal.data;
  useEffect(() => {
    setKnown((previous) => {
      const base = previous.agentId === agentId ? previous.times : EMPTY_TIMES;
      const times = mergeTimes(mergeTimes(base, journalTimes ?? EMPTY_TIMES), snapshotTimes);
      return times === previous.times && previous.agentId === agentId
        ? previous
        : { agentId, times };
    });
  }, [agentId, journalTimes, snapshotTimes]);
  return known.agentId === agentId ? known.times : EMPTY_TIMES;
}
