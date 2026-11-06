import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { PromptCacheHistoryEntry } from "@getpaseo/protocol/agent-cache-warm";
import { useFetchQuery } from "@/data/query";
import { useSettings } from "@/hooks/use-settings";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import {
  estimateTurnCostUsd,
  estimateWarmUpStretchCostUsd,
  resolveMoneyStatsPricer,
  resolveWriteTtl,
} from "./money-stats";
import type { RequestPricer } from "./prompt-cache-insights";
import { resolvePromptCacheView, usePromptCacheAgent } from "./use-prompt-cache";

const EMPTY: readonly PromptCacheHistoryEntry[] = [];

/** Whether the user turned money figures on; off by default. */
export function useMoneyStatsEnabled(): boolean {
  return useSettings((settings) => settings.promptCacheMoneyStats);
}

/** The pricer for an agent's requests while money figures are on and apply to its model. */
export function useMoneyStatsPricer(serverId: string, agentId: string): RequestPricer | null {
  const enabled = useMoneyStatsEnabled();
  const agent = usePromptCacheAgent(serverId, agentId);
  const ttl = resolveWriteTtl(resolvePromptCacheView(agent, 0).windows);
  const model = agent?.model ?? agent?.runtimeInfo?.model;
  const provider = agent?.provider;
  return useMemo(
    () =>
      enabled && provider
        ? resolveMoneyStatsPricer({
            agent: { provider, model: model ?? null, runtimeInfo: undefined },
            ttl,
          })
        : null,
    [enabled, provider, model, ttl],
  );
}

function mergeEntries(
  known: readonly PromptCacheHistoryEntry[],
  incoming: readonly PromptCacheHistoryEntry[],
): readonly PromptCacheHistoryEntry[] {
  const seen = new Set(known.map((entry) => `${entry.at}:${entry.kind}`));
  const added = incoming.filter((entry) => !seen.has(`${entry.at}:${entry.kind}`));
  if (added.length === 0) return known;
  return [...known, ...added].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Every request of the agent while the chat is open: the journal read once, then each request the
 * snapshot brings. The snapshot alone holds only the latest few, which would price an older turn
 * as free.
 */
function usePromptCacheLedger(input: {
  serverId: string;
  agentId: string;
  enabled: boolean;
}): readonly PromptCacheHistoryEntry[] {
  const { serverId, agentId, enabled } = input;
  const agent = usePromptCacheAgent(serverId, agentId);
  const client = useHostRuntimeClient(serverId);
  const journalSupported = useHostFeature(serverId, "promptCacheInsights");
  const snapshotHistory = agent?.promptCache?.history ?? EMPTY;
  const journal = useFetchQuery<readonly PromptCacheHistoryEntry[], Error>({
    queryKey: ["promptCacheMoneyLedger", serverId, agentId],
    queryFn: async () => {
      if (!client) return EMPTY;
      const payload = await client.getPromptCacheHistory({ agentId });
      if (payload.error) throw new Error(payload.error);
      return payload.requests;
    },
    enabled: Boolean(enabled && client && journalSupported),
    retry: false,
    dataShape: "value",
    // Recorded requests never change; later ones arrive on the snapshot.
    immutableWhen: () => true,
  });
  const [known, setKnown] = useState<{
    agentId: string;
    entries: readonly PromptCacheHistoryEntry[];
  }>({ agentId, entries: EMPTY });
  const journalEntries = journal.data;
  useEffect(() => {
    if (!enabled) return;
    setKnown((previous) => {
      const base = previous.agentId === agentId ? previous.entries : EMPTY;
      const entries = mergeEntries(mergeEntries(base, journalEntries ?? EMPTY), snapshotHistory);
      return entries === previous.entries && previous.agentId === agentId
        ? previous
        : { agentId, entries };
    });
  }, [agentId, enabled, journalEntries, snapshotHistory]);
  return enabled && known.agentId === agentId ? known.entries : EMPTY;
}

interface PromptCacheMoney {
  turnCostUsd: (startedAtMs: number, completedAtMs: number) => number | null;
  warmUpStretchCostUsd: (firstAtMs: number, lastAtMs: number) => number | null;
}

const PromptCacheMoneyContext = createContext<PromptCacheMoney | null>(null);

/** Gives the chat's turn footers and warm-up lines their ≈ $ figures while money stats are on. */
export function PromptCacheMoneyProvider({
  serverId,
  agentId,
  children,
}: {
  serverId: string;
  agentId: string;
  children: ReactNode;
}) {
  const price = useMoneyStatsPricer(serverId, agentId);
  const entries = usePromptCacheLedger({ serverId, agentId, enabled: price !== null });
  const value = useMemo<PromptCacheMoney | null>(
    () =>
      price
        ? {
            turnCostUsd: (startedAtMs, completedAtMs) =>
              estimateTurnCostUsd({ entries, price, startedAtMs, completedAtMs }),
            warmUpStretchCostUsd: (firstAtMs, lastAtMs) =>
              estimateWarmUpStretchCostUsd({ entries, price, firstAtMs, lastAtMs }),
          }
        : null,
    [entries, price],
  );
  return (
    <PromptCacheMoneyContext.Provider value={value}>{children}</PromptCacheMoneyContext.Provider>
  );
}

/** Null while money stats are off or the agent's model has no price. */
export function usePromptCacheMoney(): PromptCacheMoney | null {
  return useContext(PromptCacheMoneyContext);
}
