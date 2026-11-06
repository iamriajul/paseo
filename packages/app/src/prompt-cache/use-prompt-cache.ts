import { useCallback, useEffect, useState } from "react";
import { Alert } from "react-native";
import { isDelegatedAgent } from "@getpaseo/protocol/agent-labels";
import {
  applyCacheWarmMaxPings,
  CACHE_WARM_MAX_PINGS_FEATURE_ID,
  isClaudeModel,
  sumPromptCacheTotals,
  visiblePromptCacheMisses,
  type PromptCacheTotals,
  isQuestionPermission,
  isWarmUpPausedAtIdleCap,
  lastTurnWasCompaction,
  resolveCacheWarmEnabled,
  resolveEffectivePromptCacheWindows,
  resolvePromptCacheAnchorMs,
  resolvePromptCacheWindows,
  type PromptCacheRequestSample,
  type PromptCacheWindows,
} from "@getpaseo/protocol/agent-cache-warm";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  summarizePromptCacheHistory,
  type PromptCacheHistorySummary,
} from "./prompt-cache-history";

export type PromptCacheStatus =
  | { kind: "automatic" }
  /** Counts on through tool calls, which refresh nothing; null before any request. */
  | { kind: "busy"; remainingMs: number | null }
  | { kind: "busy-expired" }
  | { kind: "awaiting-question"; remainingMs: number }
  | { kind: "awaiting-permission"; remainingMs: number }
  | { kind: "warm"; remainingMs: number }
  | { kind: "expired" };

export type PromptCacheWarmupPlan =
  | { kind: "off" }
  | { kind: "after-turn" }
  | { kind: "expired" }
  | { kind: "capped" }
  /** Compacted at the idle cap; the user's next message resumes warm-up. */
  | { kind: "paused-after-compaction" }
  | { kind: "parent-answers" }
  | { kind: "waits-for-permission" }
  | { kind: "pauses-question"; remainingMs: number }
  | { kind: "next-ping"; remainingMs: number };

export interface PromptCacheWarmup {
  enabled: boolean;
  plan: PromptCacheWarmupPlan;
  pingsUsed: number;
  /** The agent's cap per idle stretch: its own choice, else the window's maximum. */
  maxPings: number;
  /** The window's own maximum, the top of the cap's range. */
  windowMaxPings: number;
  totalPings: number;
  /**
   * Time until the cache expires once the cap's remaining warm-ups are spent, while warm-up is
   * counting towards the cap; null otherwise (off, paused, after a turn, expired).
   */
  coverEndsInMs: number | null;
}

export interface PromptCacheState {
  isClaude: boolean;
  /**
   * The windows the running process writes at: the latest cache write's TTL, else the Cache
   * window. Null while Automatic and no write has been seen.
   */
  windows: PromptCacheWindows | null;
  status: PromptCacheStatus;
  /** Null while the Cache window is Automatic, where warm-up is unavailable. */
  warmup: PromptCacheWarmup | null;
  /** First request of the latest turn, so it reports how the last prompt met the cache. */
  lastPrompt: PromptCacheRequestSample | null;
  /** Recent prompts and how each met the cache; null before the first recorded prompt. */
  history: PromptCacheHistorySummary | null;
  /** Avoidable misses since the user last cleared the count: the red number beside the countdown. */
  misses: number;
  /** Avoidable misses over the whole session, cleared or not; insights show these. */
  sessionMisses: number;
  /** When the user last cleared the red count, or null when never. */
  missesClearedAt: string | null;
  /** Requests over the whole session; it changes whenever a request is recorded. */
  requests: number;
  /** Nothing of the agent's own ran since its latest compaction, so a message writes only that. */
  lastTurnCompacted: boolean;
  toggleWarmup: () => Promise<void>;
  /** Clears the red count; null when the host cannot. */
  clearMisses: (() => Promise<void>) | null;
  /** Sets the agent's warm-up cap; null when the host does not enforce one. */
  setMaxPings: ((maxPings: number) => Promise<void>) | null;
  /** Flips each second while a countdown ticks, so a near-cap countdown can blink. */
  blinkOn: boolean;
}

interface AgentCacheFacts {
  windows: PromptCacheWindows | null;
  /** The window's cap before the agent's own; the top of the cap's range. */
  windowMaxPings: number | null;
  /** Warm-up needs a chosen Cache window; an observed TTL under Automatic does not enable it. */
  warmupAvailable: boolean;
  isDelegated: boolean;
  isBusy: boolean;
  hasPendingQuestion: boolean;
  hasPendingPermission: boolean;
  anchorMs: number | null;
  warmupEnabled: boolean;
  pingsUsed: number;
  totalPings: number;
  pausedAtIdleCap: boolean;
}

function readFeatureValue(agent: Agent, id: string): unknown {
  return agent.features?.find((feature) => feature.id === id)?.value;
}

function readAgentCacheFacts(agent: Agent): AgentCacheFacts {
  const promptCacheTtl = readFeatureValue(agent, "prompt_cache_ttl");
  const pending = agent.pendingPermissions ?? [];
  const hasPendingPermission = pending.length > 0;
  const windows = resolveEffectivePromptCacheWindows({
    observedTtl: agent.promptCache?.observedTtl,
    promptCacheTtl,
  });
  return {
    windows: windows ? applyCacheWarmMaxPings(windows, agent.cacheWarmMaxPings) : null,
    windowMaxPings: windows?.maxConsecutivePings ?? null,
    warmupAvailable: resolvePromptCacheWindows(promptCacheTtl) !== null,
    isDelegated: isDelegatedAgent({ labels: agent.labels }),
    isBusy: (agent.status === "running" || agent.turn?.phase === "open") && !hasPendingPermission,
    hasPendingQuestion: pending.some((request) => isQuestionPermission(request)),
    hasPendingPermission,
    anchorMs: resolvePromptCacheAnchorMs(agent),
    warmupEnabled: resolveCacheWarmEnabled({
      promptCacheTtl,
      explicitValue: readFeatureValue(agent, "cache_warm"),
    }),
    pingsUsed: agent.consecutiveWarmPings ?? 0,
    totalPings: agent.totalWarmPings ?? 0,
    pausedAtIdleCap: isWarmUpPausedAtIdleCap(agent.promptCache),
  };
}

function resolveStatus(facts: AgentCacheFacts, now: number): PromptCacheStatus {
  if (!facts.windows) {
    return { kind: "automatic" };
  }
  const remainingMs =
    facts.anchorMs === null ? 0 : facts.anchorMs + facts.windows.cacheWindowMs - now;
  if (facts.isBusy) {
    if (facts.anchorMs === null) return { kind: "busy", remainingMs: null };
    return remainingMs > 0 ? { kind: "busy", remainingMs } : { kind: "busy-expired" };
  }
  if (remainingMs <= 0) {
    return { kind: "expired" };
  }
  if (facts.hasPendingQuestion) {
    return { kind: "awaiting-question", remainingMs };
  }
  if (facts.hasPendingPermission) {
    return { kind: "awaiting-permission", remainingMs };
  }
  return { kind: "warm", remainingMs };
}

function resolveWarmupPlan(input: {
  facts: AgentCacheFacts;
  windows: PromptCacheWindows;
  status: PromptCacheStatus;
  now: number;
  /** The host warms through a fork, which needs no idle agent. */
  forkWarm: boolean;
}): PromptCacheWarmupPlan {
  const { facts, windows, status, now } = input;
  if (!facts.warmupEnabled) return { kind: "off" };
  if (facts.pausedAtIdleCap) return { kind: "paused-after-compaction" };
  if (input.forkWarm) return resolveForkWarmPlan({ facts, windows, status, now });
  if (status.kind === "busy" || status.kind === "busy-expired") return { kind: "after-turn" };
  if (status.kind === "expired" || facts.anchorMs === null) return { kind: "expired" };
  if (facts.pingsUsed >= windows.maxConsecutivePings) return { kind: "capped" };
  const remainingMs = Math.max(0, facts.anchorMs + windows.warmIntervalMs - now);
  if (status.kind === "awaiting-question") {
    return facts.isDelegated
      ? { kind: "parent-answers" }
      : { kind: "pauses-question", remainingMs };
  }
  if (status.kind === "awaiting-permission") return { kind: "waits-for-permission" };
  return { kind: "next-ping", remainingMs };
}

/**
 * A host that warms through a fork reaches the cache without the agent, so a running turn, a
 * pending permission and an open question all count down to the next warm-up like an idle agent.
 */
function resolveForkWarmPlan(input: {
  facts: AgentCacheFacts;
  windows: PromptCacheWindows;
  status: PromptCacheStatus;
  now: number;
}): PromptCacheWarmupPlan {
  const { facts, windows, status, now } = input;
  if (status.kind === "expired" || status.kind === "busy-expired" || facts.anchorMs === null) {
    return { kind: "expired" };
  }
  if (facts.pingsUsed >= windows.maxConsecutivePings) return { kind: "capped" };
  return {
    kind: "next-ping",
    remainingMs: Math.max(0, facts.anchorMs + windows.warmIntervalMs - now),
  };
}

function hasLiveCountdown(status: PromptCacheStatus): boolean {
  return (
    (status.kind === "busy" && status.remainingMs !== null) ||
    status.kind === "warm" ||
    status.kind === "awaiting-question" ||
    status.kind === "awaiting-permission"
  );
}

/** Records written before totals existed count their snapshot window until the next request. */
function resolveTotals(agent: Agent | undefined): PromptCacheTotals {
  const promptCache = agent?.promptCache;
  return promptCache?.totals ?? sumPromptCacheTotals(promptCache?.history ?? []);
}

export type PromptCacheView = Omit<
  PromptCacheState,
  "toggleWarmup" | "clearMisses" | "setMaxPings" | "blinkOn"
>;

function resolveMissCounts(
  totals: PromptCacheTotals,
  agent: Agent | undefined,
): Pick<PromptCacheView, "misses" | "sessionMisses" | "missesClearedAt"> {
  const cleared = agent?.promptCache?.missesCleared;
  return {
    misses: visiblePromptCacheMisses(totals, cleared),
    sessionMisses: totals.misses,
    missesClearedAt: cleared?.at ?? null,
  };
}

/**
 * When warm-up stops covering the cache: each remaining warm-up re-arms the window one interval
 * after the previous request, and the last one leaves the cache a full window to live.
 */
function resolveCoverEndsInMs(input: {
  facts: AgentCacheFacts;
  windows: PromptCacheWindows;
  plan: PromptCacheWarmupPlan;
  now: number;
}): number | null {
  const { facts, windows, plan, now } = input;
  if ((plan.kind !== "next-ping" && plan.kind !== "capped") || facts.anchorMs === null) {
    return null;
  }
  const remainingPings = Math.max(0, windows.maxConsecutivePings - facts.pingsUsed);
  const endsAtMs = facts.anchorMs + remainingPings * windows.warmIntervalMs + windows.cacheWindowMs;
  return Math.max(0, endsAtMs - now);
}

/** Null while the Cache window is Automatic, where warm-up is unavailable. */
function resolveWarmup(input: {
  facts: AgentCacheFacts;
  status: PromptCacheStatus;
  now: number;
  forkWarm: boolean;
}): PromptCacheWarmup | null {
  const { facts, status, now, forkWarm } = input;
  const { windows } = facts;
  if (!windows || !facts.warmupAvailable) return null;
  const plan = resolveWarmupPlan({ facts, windows, status, now, forkWarm });
  return {
    enabled: facts.warmupEnabled,
    plan,
    coverEndsInMs: resolveCoverEndsInMs({ facts, windows, plan, now }),
    pingsUsed: Math.min(facts.pingsUsed, windows.maxConsecutivePings),
    maxPings: windows.maxConsecutivePings,
    windowMaxPings: facts.windowMaxPings ?? windows.maxConsecutivePings,
    totalPings: facts.totalPings,
  };
}

/** Everything the cache surfaces show for one agent at one instant; no React, no clock. */
export function resolvePromptCacheView(
  agent: Agent | undefined,
  now: number,
  options?: { forkWarm?: boolean },
): PromptCacheView {
  const totals = resolveTotals(agent);
  const isClaude = Boolean(
    agent && agent.provider === "claude" && isClaudeModel(agent.model ?? agent.runtimeInfo?.model),
  );
  const facts = agent && isClaude ? readAgentCacheFacts(agent) : null;
  const status: PromptCacheStatus = facts ? resolveStatus(facts, now) : { kind: "automatic" };
  const warmup = facts
    ? resolveWarmup({ facts, status, now, forkWarm: options?.forkWarm === true })
    : null;
  return {
    isClaude,
    windows: facts?.windows ?? null,
    status,
    warmup,
    lastPrompt: agent?.promptCache?.turnFirstRequest ?? null,
    history: summarizePromptCacheHistory(agent?.promptCache?.history),
    ...resolveMissCounts(totals, agent),
    requests: totals.requests,
    lastTurnCompacted: lastTurnWasCompaction(agent?.promptCache),
  };
}

/**
 * The current time, re-rendering once a second while `active` so a countdown can show seconds.
 * It reads the clock on every render rather than holding the last tick: a value held while
 * nothing ticked goes stale, and the next state change would be judged against it.
 */
export function useSecondClock(active: boolean): number {
  "use no memo";
  // React Compiler treats Date.now() as pure and caches it, which freezes the countdown.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(interval);
  }, [active]);
  return Date.now();
}

export function usePromptCacheAgent(serverId: string, agentId: string): Agent | undefined {
  return useSessionStore((state) => {
    const session = state.sessions[serverId];
    return session?.agents?.get(agentId) ?? session?.agentDetails?.get(agentId);
  });
}

/** Claude agents on a host whose red miss count is above zero; the host settings clear them all. */
export function agentIdsWithVisibleMisses(agents: Iterable<Agent>): string[] {
  const ids: string[] = [];
  for (const agent of agents) {
    const view = resolvePromptCacheView(agent, 0);
    if (view.isClaude && view.misses > 0) ids.push(agent.id);
  }
  return ids;
}

export function usePromptCache(serverId: string, agentId: string): PromptCacheState {
  "use no memo";
  const client = useHostRuntimeClient(serverId);
  const agent = usePromptCacheAgent(serverId, agentId);
  const forkWarm = useHostFeature(serverId, "cacheWarmFork");
  const ticking = hasLiveCountdown(resolvePromptCacheView(agent, Date.now()).status);
  const now = useSecondClock(ticking);
  const view = resolvePromptCacheView(agent, now, { forkWarm });
  const { status, warmup } = view;

  const warmupEnabled = warmup?.enabled ?? false;
  const canTurnOn = status.kind !== "expired" && status.kind !== "automatic";
  const toggleWarmup = useCallback(async () => {
    if (!client) return;
    if (!warmupEnabled && !canTurnOn) return;
    await client.setAgentFeature(agentId, "cache_warm", !warmupEnabled);
  }, [client, agentId, warmupEnabled, canTurnOn]);
  const canClearMisses = useHostFeature(serverId, "promptCacheClearMisses");
  const clearMisses = useCallback(async () => {
    if (!client) return;
    try {
      const payload = await client.clearPromptCacheMisses({ agentIds: [agentId] });
      if (payload.error) throw new Error(payload.error);
    } catch (error) {
      Alert.alert(
        "Unable to clear the miss count",
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [client, agentId]);

  const canSetMaxPings = useHostFeature(serverId, "cacheWarmMaxPings");
  const setMaxPings = useCallback(
    async (maxPings: number) => {
      if (!client) return;
      await client.setAgentFeature(agentId, CACHE_WARM_MAX_PINGS_FEATURE_ID, maxPings);
    },
    [client, agentId],
  );

  return {
    ...view,
    toggleWarmup,
    clearMisses: canClearMisses && client ? clearMisses : null,
    setMaxPings: canSetMaxPings && client ? setMaxPings : null,
    blinkOn: Math.floor(now / 1000) % 2 === 0,
  };
}
