import { useCallback, useEffect, useState } from "react";
import { isDelegatedAgent } from "@getpaseo/protocol/agent-labels";
import { resolvePromptCacheWindows } from "@getpaseo/protocol/agent-cache-warm";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore, type Agent } from "@/stores/session-store";

export interface PromptCacheState {
  isClaude: boolean;
  isSubagent: boolean;
  cacheWindowMs: number;
  warmIntervalMs: number;
  maxConsecutivePings: number;
  consecutivePings: number;
  isCapped: boolean;
  isWarm: boolean;
  remainingMs: number;
  countdownText: string;
  nextPingRemainingMs: number;
  nextPingCountdownText: string;
  isWarmupEnabled: boolean;
  isBusy: boolean;
  toggleWarmup: () => Promise<void>;
}

function resolveCacheWindows(agent: Agent | null | undefined, isSubagent: boolean) {
  const promptCacheTtl = agent?.features?.find((f) => f.id === "prompt_cache_ttl")?.value;
  return resolvePromptCacheWindows({ isSubagent, promptCacheTtl });
}

function resolveLastResponseTime(agent: Agent | null | undefined, fallbackNow: number): number {
  if (agent?.lastResponseAt) {
    return new Date(agent.lastResponseAt).getTime();
  }
  if (agent?.updatedAt) {
    return new Date(agent.updatedAt).getTime();
  }
  return fallbackNow;
}

function formatCountdownText(isBusy: boolean, remainingMs: number): string {
  if (isBusy) return "active";
  if (remainingMs <= 0) return "expired";
  if (remainingMs < 60_000) return "<1m";
  const minutes = Math.round(remainingMs / 60_000);
  return `in ${minutes}m`;
}

function formatNextPingCountdownText(
  isBusy: boolean,
  isCapped: boolean,
  remainingMs: number,
): string {
  if (isBusy) return "active";
  if (isCapped) return "capped";
  if (remainingMs <= 0) return "<1m";
  if (remainingMs < 60_000) return "<1m";
  const minutes = Math.round(remainingMs / 60_000);
  return `in ${minutes}m`;
}

export function usePromptCache(serverId: string, agentId: string): PromptCacheState {
  const client = useHostRuntimeClient(serverId);
  const agent = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return session?.agents?.get(agentId) ?? session?.agentDetails?.get(agentId);
  });

  const isClaude = agent?.provider === "claude";
  const isSubagent = isDelegatedAgent({ labels: agent?.labels });
  const { cacheWindowMs, warmIntervalMs, maxConsecutivePings } = resolveCacheWindows(
    agent,
    isSubagent,
  );
  const isWarmupEnabled = agent?.features?.find((f) => f.id === "cache_warm")?.value === true;
  const isBusy = agent?.status === "running" || agent?.turn?.phase === "open";

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isClaude) return;
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 10_000);
    return () => clearInterval(interval);
  }, [isClaude]);

  const lastResponseTime = resolveLastResponseTime(agent, now);
  const expiresAtMs = lastResponseTime + cacheWindowMs;
  const remainingMs = Math.max(0, expiresAtMs - now);
  const isWarm = remainingMs > 0;
  const countdownText = formatCountdownText(isBusy, remainingMs);

  const consecutivePings = agent?.consecutiveWarmPings ?? 0;
  const isCapped = isWarmupEnabled && consecutivePings >= maxConsecutivePings;

  const nextPingAtMs = lastResponseTime + warmIntervalMs;
  const nextPingRemainingMs = Math.max(0, nextPingAtMs - now);
  const nextPingCountdownText = formatNextPingCountdownText(isBusy, isCapped, nextPingRemainingMs);

  const toggleWarmup = useCallback(async () => {
    if (!client || !agent) return;
    await client.setAgentFeature(agentId, "cache_warm", !isWarmupEnabled);
  }, [client, agent, agentId, isWarmupEnabled]);

  return {
    isClaude,
    isSubagent,
    cacheWindowMs,
    warmIntervalMs,
    maxConsecutivePings,
    consecutivePings,
    isCapped,
    isWarm,
    remainingMs,
    countdownText,
    nextPingRemainingMs,
    nextPingCountdownText,
    isWarmupEnabled,
    isBusy,
    toggleWarmup,
  };
}
