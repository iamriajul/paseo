import { useCallback, useEffect, useState } from "react";
import { isDelegatedAgent } from "@getpaseo/protocol/agent-labels";
import {
  isClaudeModel,
  isQuestionPermission,
  resolveCacheWarmEnabled,
  resolveEffectivePromptCacheWindows,
  resolvePromptCacheAnchorMs,
  resolvePromptCacheWindows,
  type PromptCacheRequestSample,
  type PromptCacheWindows,
} from "@getpaseo/protocol/agent-cache-warm";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore, type Agent } from "@/stores/session-store";

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
  | { kind: "parent-answers" }
  | { kind: "waits-for-permission" }
  | { kind: "pauses-question"; remainingMs: number }
  | { kind: "next-ping"; remainingMs: number };

export interface PromptCacheWarmup {
  enabled: boolean;
  plan: PromptCacheWarmupPlan;
  pingsUsed: number;
  maxPings: number;
  totalPings: number;
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
  toggleWarmup: () => Promise<void>;
}

interface AgentCacheFacts {
  windows: PromptCacheWindows | null;
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
}

function readFeatureValue(agent: Agent, id: string): unknown {
  return agent.features?.find((feature) => feature.id === id)?.value;
}

function readAgentCacheFacts(agent: Agent): AgentCacheFacts {
  const promptCacheTtl = readFeatureValue(agent, "prompt_cache_ttl");
  const pending = agent.pendingPermissions ?? [];
  const hasPendingPermission = pending.length > 0;
  return {
    windows: resolveEffectivePromptCacheWindows({
      observedTtl: agent.promptCache?.observedTtl,
      promptCacheTtl,
    }),
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
}): PromptCacheWarmupPlan {
  const { facts, windows, status, now } = input;
  if (!facts.warmupEnabled) return { kind: "off" };
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

function hasLiveCountdown(status: PromptCacheStatus): boolean {
  return (
    (status.kind === "busy" && status.remainingMs !== null) ||
    status.kind === "warm" ||
    status.kind === "awaiting-question" ||
    status.kind === "awaiting-permission"
  );
}

export type PromptCacheView = Omit<PromptCacheState, "toggleWarmup">;

/** Everything the cache surfaces show for one agent at one instant; no React, no clock. */
export function resolvePromptCacheView(agent: Agent | undefined, now: number): PromptCacheView {
  const isClaude = Boolean(
    agent && agent.provider === "claude" && isClaudeModel(agent.model ?? agent.runtimeInfo?.model),
  );
  const facts = agent && isClaude ? readAgentCacheFacts(agent) : null;
  const status: PromptCacheStatus = facts ? resolveStatus(facts, now) : { kind: "automatic" };
  const warmup: PromptCacheWarmup | null =
    facts?.windows && facts.warmupAvailable
      ? {
          enabled: facts.warmupEnabled,
          plan: resolveWarmupPlan({ facts, windows: facts.windows, status, now }),
          pingsUsed: Math.min(facts.pingsUsed, facts.windows.maxConsecutivePings),
          maxPings: facts.windows.maxConsecutivePings,
          totalPings: facts.totalPings,
        }
      : null;
  return {
    isClaude,
    windows: facts?.windows ?? null,
    status,
    warmup,
    lastPrompt: agent?.promptCache?.turnFirstRequest ?? null,
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

export function usePromptCache(serverId: string, agentId: string): PromptCacheState {
  "use no memo";
  const client = useHostRuntimeClient(serverId);
  const agent = usePromptCacheAgent(serverId, agentId);
  const ticking = hasLiveCountdown(resolvePromptCacheView(agent, Date.now()).status);
  const now = useSecondClock(ticking);
  const view = resolvePromptCacheView(agent, now);
  const { status, warmup } = view;

  const warmupEnabled = warmup?.enabled ?? false;
  const canTurnOn = status.kind !== "expired" && status.kind !== "automatic";
  const toggleWarmup = useCallback(async () => {
    if (!client) return;
    if (!warmupEnabled && !canTurnOn) return;
    await client.setAgentFeature(agentId, "cache_warm", !warmupEnabled);
  }, [client, agentId, warmupEnabled, canTurnOn]);

  return { ...view, toggleWarmup };
}
