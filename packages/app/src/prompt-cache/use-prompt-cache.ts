import { useCallback, useEffect, useState } from "react";
import { isDelegatedAgent } from "@getpaseo/protocol/agent-labels";
import { resolvePromptCacheWindows, isClaudeModel } from "@getpaseo/protocol/agent-cache-warm";
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
  hasPendingQuestion: boolean;
  hasPendingPermission: boolean;
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

function resolveLastResponseTime(agent: Agent | null | undefined): number | null {
  if (agent?.lastResponseAt) {
    return new Date(agent.lastResponseAt).getTime();
  }
  return null;
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
  isWarm: boolean,
  remainingMs: number,
): string {
  if (isBusy) return "active";
  if (!isWarm) return "expired";
  if (isCapped) return "capped";
  if (remainingMs <= 0) return "<1m";
  if (remainingMs < 60_000) return "<1m";
  const minutes = Math.round(remainingMs / 60_000);
  return `in ${minutes}m`;
}

interface PromptCacheLiveness {
  isWarm: boolean;
  remainingMs: number;
  countdownText: string;
  isCapped: boolean;
  nextPingRemainingMs: number;
  nextPingCountdownText: string;
}

function resolvePromptCacheLiveness(params: {
  lastResponseTime: number | null;
  cacheWindowMs: number;
  warmIntervalMs: number;
  maxConsecutivePings: number;
  consecutivePings: number;
  isWarmupEnabled: boolean;
  isBusy: boolean;
  now: number;
}): PromptCacheLiveness {
  const {
    lastResponseTime,
    cacheWindowMs,
    warmIntervalMs,
    maxConsecutivePings,
    consecutivePings,
    isWarmupEnabled,
    isBusy,
    now,
  } = params;

  const isWarm = lastResponseTime !== null && lastResponseTime + cacheWindowMs > now;
  const remainingMs =
    isWarm && lastResponseTime !== null ? Math.max(0, lastResponseTime + cacheWindowMs - now) : 0;
  const countdownText = formatCountdownText(isBusy, remainingMs);
  const isCapped = isWarmupEnabled && consecutivePings >= maxConsecutivePings;

  const nextPingAtMs = (lastResponseTime ?? now) + warmIntervalMs;
  const nextPingRemainingMs = Math.max(0, nextPingAtMs - now);
  const nextPingCountdownText = formatNextPingCountdownText(
    isBusy,
    isCapped,
    isWarm,
    nextPingRemainingMs,
  );

  return {
    isWarm,
    remainingMs,
    countdownText,
    isCapped,
    nextPingRemainingMs,
    nextPingCountdownText,
  };
}

function resolveAgentCacheFlags(agent: Agent | null | undefined) {
  if (!agent) {
    return {
      isClaude: false,
      isSubagent: false,
      isWarmupEnabled: false,
      hasPendingPermissions: false,
      hasPendingQuestion: false,
      isBusy: false,
    };
  }

  const modelId = agent.model ?? agent.runtimeInfo?.model;
  const isClaude = agent.provider === "claude" && isClaudeModel(modelId);
  const isSubagent = isDelegatedAgent({ labels: agent.labels });
  const isWarmupEnabled =
    agent.features?.some((f) => f.id === "cache_warm" && f.value === true) ?? false;
  const pending = agent.pendingPermissions ?? [];
  const hasPendingPermissions = pending.length > 0;
  const hasPendingQuestion = pending.some((p) => p.kind === "question");
  const isBusy =
    (agent.status === "running" || agent.turn?.phase === "open") && !hasPendingPermissions;

  return {
    isClaude,
    isSubagent,
    isWarmupEnabled,
    hasPendingPermissions,
    hasPendingQuestion,
    isBusy,
  };
}

export function usePromptCache(serverId: string, agentId: string): PromptCacheState {
  const client = useHostRuntimeClient(serverId);
  const agent = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return session?.agents?.get(agentId) ?? session?.agentDetails?.get(agentId);
  });

  const flags = resolveAgentCacheFlags(agent);
  const { cacheWindowMs, warmIntervalMs, maxConsecutivePings } = resolveCacheWindows(
    agent,
    flags.isSubagent,
  );

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!flags.isClaude) return;
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 10_000);
    return () => clearInterval(interval);
  }, [flags.isClaude]);

  const lastResponseTime = resolveLastResponseTime(agent);
  const consecutivePings = agent?.consecutiveWarmPings ?? 0;
  const liveness = resolvePromptCacheLiveness({
    lastResponseTime,
    cacheWindowMs,
    warmIntervalMs,
    maxConsecutivePings,
    consecutivePings,
    isWarmupEnabled: flags.isWarmupEnabled,
    isBusy: flags.isBusy,
    now,
  });

  const toggleWarmup = useCallback(async () => {
    if (!client || !agent) return;
    if (!flags.isWarmupEnabled && !liveness.isWarm) return;
    await client.setAgentFeature(agentId, "cache_warm", !flags.isWarmupEnabled);
  }, [client, agent, agentId, flags.isWarmupEnabled, liveness.isWarm]);

  return {
    isClaude: flags.isClaude,
    isSubagent: flags.isSubagent,
    cacheWindowMs,
    warmIntervalMs,
    maxConsecutivePings,
    consecutivePings,
    isCapped: liveness.isCapped,
    isWarm: liveness.isWarm,
    hasPendingQuestion: flags.hasPendingQuestion,
    hasPendingPermission: flags.hasPendingPermissions,
    remainingMs: liveness.remainingMs,
    countdownText: liveness.countdownText,
    nextPingRemainingMs: liveness.nextPingRemainingMs,
    nextPingCountdownText: liveness.nextPingCountdownText,
    isWarmupEnabled: flags.isWarmupEnabled,
    isBusy: flags.isBusy,
    toggleWarmup,
  };
}
