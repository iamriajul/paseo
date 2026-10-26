import type { Logger } from "pino";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import {
  DEFAULT_CACHE_WARM_PING_PROMPT,
  DEFAULT_CACHE_WARM_INTERVAL_MS,
  SUBAGENT_CACHE_WARM_INTERVAL_MS,
  DEFAULT_CACHE_WARM_MAX_PINGS,
  SUBAGENT_CACHE_WARM_MAX_PINGS,
  resolvePromptCacheWindows,
  isCacheWarmPrompt,
  isCacheWarmReply,
} from "@getpaseo/protocol/agent-cache-warm";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { sendPromptToAgent } from "./agent-prompt.js";
import {
  CLAUDE_CACHE_WARM_FEATURE_ID,
  CLAUDE_PROMPT_CACHE_TTL_FEATURE_ID,
} from "./providers/claude/feature-definitions.js";

export {
  DEFAULT_CACHE_WARM_PING_PROMPT,
  DEFAULT_CACHE_WARM_INTERVAL_MS,
  SUBAGENT_CACHE_WARM_INTERVAL_MS,
  DEFAULT_CACHE_WARM_MAX_PINGS,
  SUBAGENT_CACHE_WARM_MAX_PINGS,
  resolvePromptCacheWindows,
  isCacheWarmPrompt,
  isCacheWarmReply,
};

export function resolveAgentCacheWindowMs(agent: ManagedAgent): number {
  const isSubagent = getParentAgentIdFromLabels(agent.labels) !== null;
  const ttlSetting = agent.config?.featureValues?.[CLAUDE_PROMPT_CACHE_TTL_FEATURE_ID];
  return resolvePromptCacheWindows({ isSubagent, promptCacheTtl: ttlSetting }).cacheWindowMs;
}

export function resolveAgentCacheWarmIntervalMs(
  agent: ManagedAgent,
  configuredIntervalMs?: number,
): number {
  if (configuredIntervalMs !== undefined) {
    return configuredIntervalMs;
  }
  const isSubagent = getParentAgentIdFromLabels(agent.labels) !== null;
  const ttlSetting = agent.config?.featureValues?.[CLAUDE_PROMPT_CACHE_TTL_FEATURE_ID];
  return resolvePromptCacheWindows({ isSubagent, promptCacheTtl: ttlSetting }).warmIntervalMs;
}

export function resolveAgentCacheWarmMaxPings(agent: ManagedAgent): number {
  const isSubagent = getParentAgentIdFromLabels(agent.labels) !== null;
  const ttlSetting = agent.config?.featureValues?.[CLAUDE_PROMPT_CACHE_TTL_FEATURE_ID];
  return resolvePromptCacheWindows({ isSubagent, promptCacheTtl: ttlSetting }).maxConsecutivePings;
}

interface ActiveCacheWarmTimerEntry {
  timeout: NodeJS.Timeout;
  scheduledFor: Date;
}

export interface AgentCacheWarmManagerDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  sendPrompt?: typeof sendPromptToAgent;
  intervalMs?: number;
  pingPrompt?: string;
  now?: () => number;
}

export class AgentCacheWarmManager {
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly logger: Logger;
  private readonly send: typeof sendPromptToAgent;
  private readonly configuredIntervalMs?: number;
  private readonly pingPrompt: string;
  private readonly now: () => number;

  private readonly activeTimers = new Map<string, ActiveCacheWarmTimerEntry>();
  private readonly lastResponseTimestamps = new Map<string, number>();
  private readonly agentEpochs = new Map<string, number>();
  private readonly consecutivePings = new Map<string, number>();

  constructor(dependencies: AgentCacheWarmManagerDependencies) {
    this.agentManager = dependencies.agentManager;
    this.agentStorage = dependencies.agentStorage;
    this.logger = dependencies.logger;
    this.send = dependencies.sendPrompt ?? sendPromptToAgent;
    this.configuredIntervalMs = dependencies.intervalMs;
    this.pingPrompt = dependencies.pingPrompt ?? DEFAULT_CACHE_WARM_PING_PROMPT;
    this.now = dependencies.now ?? (() => Date.now());
  }

  private nextEpoch(agentId: string): number {
    const next = (this.agentEpochs.get(agentId) ?? 0) + 1;
    this.agentEpochs.set(agentId, next);
    return next;
  }

  getConsecutivePings(agentId: string): number {
    return (
      this.consecutivePings.get(agentId) ??
      this.agentManager.getAgent(agentId)?.consecutiveWarmPings ??
      0
    );
  }

  onAgentRegistered(agentId: string, count?: number | null): void {
    if (count && count > 0) {
      this.consecutivePings.set(agentId, count);
    }
  }

  private setConsecutivePings(agentId: string, count: number): void {
    if (count <= 0) {
      this.consecutivePings.delete(agentId);
    } else {
      this.consecutivePings.set(agentId, count);
    }
    const agent = this.agentManager.getAgent(agentId);
    if (agent) {
      agent.consecutiveWarmPings = count;
    }
  }

  resetConsecutivePings(agentId: string): void {
    this.setConsecutivePings(agentId, 0);
  }

  hasPending(agentId: string): boolean {
    return this.activeTimers.has(agentId);
  }

  getPending(agentId: string): { scheduledFor: Date } | null {
    const entry = this.activeTimers.get(agentId);
    if (!entry) return null;
    return { scheduledFor: entry.scheduledFor };
  }

  isFeatureEnabled(agentId: string): boolean {
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) {
      return false;
    }
    return agent.config.featureValues?.[CLAUDE_CACHE_WARM_FEATURE_ID] === true;
  }

  onFeatureToggled(agentId: string, enabled: boolean): void {
    this.setConsecutivePings(agentId, 0);
    if (enabled) {
      this.schedule(agentId);
    } else {
      this.cancel(agentId);
    }
  }

  onTurnStarted(agentId: string): void {
    this.cancelTimerOnly(agentId);
    const agent = this.agentManager.getAgent(agentId);
    if (!agent?.activeTurnIsWarmPing) {
      this.setConsecutivePings(agentId, 0);
    }
  }

  onTurnCompleted(agentId: string, timestamp?: Date): void {
    this.onResponseOccurred(agentId, timestamp);
  }

  onResponseOccurred(agentId: string, timestamp?: Date): void {
    const timeMs = timestamp ? timestamp.getTime() : this.now();
    this.lastResponseTimestamps.set(agentId, timeMs);
    if (this.isFeatureEnabled(agentId)) {
      this.schedule(agentId);
    }
  }

  onMessageActivity(agentId: string, timestamp?: Date): void {
    this.setConsecutivePings(agentId, 0);
    this.onResponseOccurred(agentId, timestamp);
  }

  private resolveAgentLastTime(agent: ManagedAgent): number {
    return (
      this.lastResponseTimestamps.get(agent.id) ??
      agent.lastResponseAt?.getTime() ??
      agent.updatedAt?.getTime() ??
      this.now()
    );
  }

  schedule(agentId: string): boolean {
    const agent = this.agentManager.getAgent(agentId);
    if (!agent || agent.lifecycle === "closed") {
      this.cancel(agentId);
      return false;
    }

    if (!this.isFeatureEnabled(agentId)) {
      this.cancel(agentId);
      return false;
    }

    if (agent.lifecycle !== "idle" || this.agentManager.hasInFlightRun?.(agentId)) {
      return false;
    }

    if (agent.pendingPermissions && agent.pendingPermissions.size > 0) {
      return false;
    }

    if (!agent.lastResponseAt && !agent.lastUserMessageAt) {
      return false;
    }

    const maxPings = resolveAgentCacheWarmMaxPings(agent);
    const consecutiveCount = this.getConsecutivePings(agentId);
    if (consecutiveCount >= maxPings) {
      this.logger.debug(
        { agentId, consecutiveCount, maxPings },
        "Skipping cache warm schedule: reached auto-cap for this idle stretch",
      );
      return false;
    }

    const intervalMs = resolveAgentCacheWarmIntervalMs(agent, this.configuredIntervalMs);
    const lastTime = this.resolveAgentLastTime(agent);
    const elapsedMs = this.now() - lastTime;
    const remainingMs = Math.max(0, intervalMs - elapsedMs);

    this.cancelTimerOnly(agentId);
    const scheduledEpoch = this.nextEpoch(agentId);

    this.logger.debug(
      { agentId, remainingMs, intervalMs },
      "Scheduling cache warm watchdog timer from last response",
    );

    const timeout = setTimeout(() => {
      void this.triggerPing(agentId, scheduledEpoch);
    }, remainingMs);
    timeout.unref?.();

    this.activeTimers.set(agentId, {
      timeout,
      scheduledFor: new Date(this.now() + remainingMs),
    });

    return true;
  }

  async triggerPing(agentId: string, expectedEpoch: number): Promise<boolean> {
    if (this.agentEpochs.get(agentId) !== expectedEpoch) {
      return false;
    }
    this.activeTimers.delete(agentId);

    const agent = this.agentManager.getAgent(agentId);
    if (!agent || agent.lifecycle === "closed") {
      return false;
    }

    if (!this.isFeatureEnabled(agentId)) {
      return false;
    }

    if (agent.lifecycle !== "idle" || this.agentManager.hasInFlightRun?.(agentId)) {
      this.logger.debug({ agentId }, "Skipping cache warm ping: agent is not idle");
      return false;
    }

    if (agent.pendingPermissions && agent.pendingPermissions.size > 0) {
      this.logger.debug({ agentId }, "Skipping cache warm ping: agent has pending permissions");
      return false;
    }

    const intervalMs = resolveAgentCacheWarmIntervalMs(agent, this.configuredIntervalMs);
    const lastTime = this.resolveAgentLastTime(agent);
    const elapsedMs = this.now() - lastTime;
    if (elapsedMs < intervalMs) {
      this.logger.debug(
        { agentId, elapsedMs, intervalMs },
        "Rescheduling cache warm ping: response occurred recently",
      );
      this.schedule(agentId);
      return false;
    }

    const maxPings = resolveAgentCacheWarmMaxPings(agent);
    const consecutiveCount = this.getConsecutivePings(agentId);
    if (consecutiveCount >= maxPings) {
      this.logger.debug(
        { agentId, consecutiveCount, maxPings },
        "Skipping cache warm ping: auto-cap reached for this idle stretch",
      );
      return false;
    }

    this.logger.info(
      { agentId, pingNumber: consecutiveCount + 1, maxPings },
      "Sending cache warm ping to keep prompt cache warm",
    );
    this.lastResponseTimestamps.set(agentId, this.now());

    try {
      const result = await this.send({
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        agentId,
        prompt: this.pingPrompt,
        replaceRunning: false,
        unarchive: false,
        logger: this.logger,
        runOptions: {
          isWarmPing: true,
        },
      });
      if (result.disposition === "skipped") {
        this.logger.debug(
          { agentId },
          "Cache warm ping skipped because agent is busy; rescheduling",
        );
        this.schedule(agentId);
        return false;
      }
      this.setConsecutivePings(agentId, consecutiveCount + 1);
      return true;
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "Failed to send cache warm ping; rescheduling");
      this.schedule(agentId);
      return false;
    }
  }

  cancel(agentId: string): void {
    this.nextEpoch(agentId);
    this.cancelTimerOnly(agentId);
    this.setConsecutivePings(agentId, 0);
  }

  deleteAgent(agentId: string): void {
    this.cancel(agentId);
    this.lastResponseTimestamps.delete(agentId);
    this.agentEpochs.delete(agentId);
  }

  cancelAll(): void {
    for (const entry of this.activeTimers.values()) {
      clearTimeout(entry.timeout);
    }
    this.activeTimers.clear();
    for (const agentId of this.agentEpochs.keys()) {
      this.nextEpoch(agentId);
    }
    for (const agentId of Array.from(this.consecutivePings.keys())) {
      this.setConsecutivePings(agentId, 0);
    }
    this.consecutivePings.clear();
  }

  bootstrap(agents: ManagedAgent[]): void {
    for (const agent of agents) {
      if (agent.consecutiveWarmPings) {
        this.onAgentRegistered(agent.id, agent.consecutiveWarmPings);
      }
      if (this.isFeatureEnabled(agent.id)) {
        this.schedule(agent.id);
      }
    }
  }

  private cancelTimerOnly(agentId: string): void {
    const existing = this.activeTimers.get(agentId);
    if (existing) {
      clearTimeout(existing.timeout);
      this.activeTimers.delete(agentId);
    }
  }
}
