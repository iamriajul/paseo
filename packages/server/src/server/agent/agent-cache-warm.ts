import type { Logger } from "pino";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import {
  DEFAULT_CACHE_WARM_PING_PROMPT,
  CACHE_WARM_QUESTION_PAUSE_MESSAGE,
  resolveEffectivePromptCacheWindows,
  resolveCacheWarmEnabled,
  resolvePromptCacheAnchorMs,
  isCacheWarmPrompt,
  isCacheWarmReply,
  isClaudeModel,
  isQuestionPermission,
  type PromptCacheTtl,
  type PromptCacheWindows,
} from "@getpaseo/protocol/agent-cache-warm";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentPermissionRequest } from "./agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import { sendPromptToAgent } from "./agent-prompt.js";
import {
  CLAUDE_CACHE_WARM_FEATURE_ID,
  CLAUDE_PROMPT_CACHE_TTL_FEATURE_ID,
} from "./providers/claude/feature-definitions.js";

export {
  DEFAULT_CACHE_WARM_PING_PROMPT,
  CACHE_WARM_QUESTION_PAUSE_MESSAGE,
  isCacheWarmPrompt,
  isCacheWarmReply,
  isQuestionPermission,
};

/** What the watchdog needs to know about an agent, whether it is loaded or only on disk. */
interface CacheWarmView {
  provider: string;
  modelId: string | null | undefined;
  featureValues: Record<string, unknown> | undefined;
  observedTtl: PromptCacheTtl | undefined;
  isDelegated: boolean;
  activity: "ready" | "busy" | "closed";
  pendingQuestions: AgentPermissionRequest[];
  hasOtherPendingPermissions: boolean;
  anchorMs: number | null;
  consecutivePings: number;
}

type CacheWarmDecision =
  | { kind: "skip"; reason: string }
  | { kind: "wait"; delayMs: number }
  | { kind: "ping"; consecutivePings: number; maxPings: number }
  | {
      kind: "interrupt-questions";
      questions: AgentPermissionRequest[];
      consecutivePings: number;
      maxPings: number;
    };

function viewLiveAgent(
  agent: ManagedAgent,
  input: { hasInFlightRun: boolean; consecutivePings: number },
): CacheWarmView {
  const pending = agent.pendingPermissions ? Array.from(agent.pendingPermissions.values()) : [];
  const pendingQuestions = pending.filter((request) => isQuestionPermission(request));
  let activity: CacheWarmView["activity"] = "busy";
  if (agent.lifecycle === "closed") {
    activity = "closed";
  } else if ((agent.lifecycle === "idle" || agent.lifecycle === "error") && !input.hasInFlightRun) {
    activity = "ready";
  }
  return {
    provider: agent.provider,
    modelId: agent.config?.model ?? agent.runtimeInfo?.model,
    featureValues: agent.config?.featureValues,
    observedTtl: agent.promptCache?.observedTtl,
    isDelegated: getParentAgentIdFromLabels(agent.labels) !== null,
    activity,
    pendingQuestions,
    hasOtherPendingPermissions: pending.length > pendingQuestions.length,
    anchorMs: resolvePromptCacheAnchorMs(agent),
    consecutivePings: input.consecutivePings,
  };
}

function viewDormantRecord(record: StoredAgentRecord, consecutivePings: number): CacheWarmView {
  // A record left "running" by a crash belongs to boot auto-resume, not to warm-up.
  const wasRunning = record.lastStatus === "running" || record.lastStatus === "initializing";
  return {
    provider: record.provider,
    modelId: record.config?.model ?? record.runtimeInfo?.model,
    featureValues: record.config?.featureValues ?? undefined,
    observedTtl: record.promptCache?.observedTtl,
    isDelegated: getParentAgentIdFromLabels(record.labels) !== null,
    activity: wasRunning ? "busy" : "ready",
    pendingQuestions: [],
    hasOtherPendingPermissions: false,
    anchorMs: resolvePromptCacheAnchorMs(record),
    consecutivePings,
  };
}

export function resolveCacheWarmWindows(view: {
  provider: string;
  modelId: string | null | undefined;
  featureValues: Record<string, unknown> | undefined;
  observedTtl: PromptCacheTtl | undefined;
}): PromptCacheWindows | null {
  if (view.provider !== "claude" || !isClaudeModel(view.modelId)) {
    return null;
  }
  const promptCacheTtl = view.featureValues?.[CLAUDE_PROMPT_CACHE_TTL_FEATURE_ID];
  const enabled = resolveCacheWarmEnabled({
    promptCacheTtl,
    explicitValue: view.featureValues?.[CLAUDE_CACHE_WARM_FEATURE_ID],
  });
  // Timed on the TTL the process really writes: after a Cache window change it keeps the old
  // one until it relaunches.
  return enabled
    ? resolveEffectivePromptCacheWindows({ observedTtl: view.observedTtl, promptCacheTtl })
    : null;
}

function decideCacheWarm(input: {
  view: CacheWarmView;
  nowMs: number;
  lastAttemptMs: number | null;
}): CacheWarmDecision {
  const { view, nowMs, lastAttemptMs } = input;
  if (view.activity === "closed") {
    return { kind: "skip", reason: "agent is closed" };
  }
  const windows = resolveCacheWarmWindows(view);
  if (!windows) {
    return { kind: "skip", reason: "warm-up is off or the cache window is Automatic" };
  }
  if (view.hasOtherPendingPermissions) {
    return { kind: "skip", reason: "agent is waiting on a tool permission" };
  }
  const hasQuestions = view.pendingQuestions.length > 0;
  if (hasQuestions && view.isDelegated) {
    return { kind: "skip", reason: "the parent agent answers this question" };
  }
  if (!hasQuestions && view.activity !== "ready") {
    return { kind: "skip", reason: "agent is busy" };
  }
  if (view.anchorMs === null) {
    return { kind: "skip", reason: "no request recorded yet" };
  }
  const elapsedMs = nowMs - view.anchorMs;
  if (elapsedMs >= windows.cacheWindowMs) {
    return { kind: "skip", reason: "cache has already expired" };
  }
  if (view.consecutivePings >= windows.maxConsecutivePings) {
    return { kind: "skip", reason: "auto-cap reached for this idle stretch" };
  }
  if (lastAttemptMs !== null && lastAttemptMs > view.anchorMs) {
    return { kind: "skip", reason: "the last warm-up did not reach Anthropic" };
  }
  if (elapsedMs < windows.warmIntervalMs) {
    return { kind: "wait", delayMs: windows.warmIntervalMs - elapsedMs };
  }
  const counts = {
    consecutivePings: view.consecutivePings,
    maxPings: windows.maxConsecutivePings,
  };
  return hasQuestions
    ? { kind: "interrupt-questions", questions: view.pendingQuestions, ...counts }
    : { kind: "ping", ...counts };
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
  pingPrompt?: string;
  now?: () => number;
}

export class AgentCacheWarmManager {
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly logger: Logger;
  private readonly send: typeof sendPromptToAgent;
  private readonly pingPrompt: string;
  private readonly now: () => number;

  private readonly activeTimers = new Map<string, ActiveCacheWarmTimerEntry>();
  private readonly agentEpochs = new Map<string, number>();
  private readonly consecutivePings = new Map<string, number>();
  private readonly lastAttemptAt = new Map<string, number>();
  private readonly pingsInFlight = new Set<string>();
  /** Agents known only from storage after a daemon restart, until something loads them. */
  private readonly dormantRecords = new Map<string, StoredAgentRecord>();

  constructor(dependencies: AgentCacheWarmManagerDependencies) {
    this.agentManager = dependencies.agentManager;
    this.agentStorage = dependencies.agentStorage;
    this.logger = dependencies.logger;
    this.send = dependencies.sendPrompt ?? sendPromptToAgent;
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
      this.dormantRecords.get(agentId)?.consecutiveWarmPings ??
      0
    );
  }

  onAgentRegistered(agentId: string, count?: number | null): void {
    this.dormantRecords.delete(agentId);
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
    this.agentManager.setCacheWarmCounts(agentId, { consecutiveWarmPings: count });
  }

  resetConsecutivePings(agentId: string): void {
    this.lastAttemptAt.delete(agentId);
    this.setConsecutivePings(agentId, 0);
  }

  getPending(agentId: string): { scheduledFor: Date } | null {
    const entry = this.activeTimers.get(agentId);
    if (!entry) return null;
    return { scheduledFor: entry.scheduledFor };
  }

  onTtlChanged(agentId: string): void {
    this.resetConsecutivePings(agentId);
    this.schedule(agentId);
  }

  onFeatureToggled(agentId: string, _enabled: boolean): void {
    this.resetConsecutivePings(agentId);
    this.schedule(agentId);
  }

  onTurnStarted(agentId: string): void {
    this.cancelTimerOnly(agentId);
    const agent = this.agentManager.getAgent(agentId);
    if (!agent?.activeTurnIsWarmPing) {
      this.resetConsecutivePings(agentId);
    }
  }

  private viewAgent(agentId: string): CacheWarmView | null {
    const agent = this.agentManager.getAgent(agentId);
    if (agent) {
      return viewLiveAgent(agent, {
        hasInFlightRun: this.agentManager.hasInFlightRun?.(agentId) ?? false,
        consecutivePings: this.getConsecutivePings(agentId),
      });
    }
    const record = this.dormantRecords.get(agentId);
    return record ? viewDormantRecord(record, this.getConsecutivePings(agentId)) : null;
  }

  private decide(agentId: string): CacheWarmDecision {
    if (this.pingsInFlight.has(agentId)) {
      return { kind: "skip", reason: "a warm-up is already being sent" };
    }
    const view = this.viewAgent(agentId);
    if (!view) {
      return { kind: "skip", reason: "agent is not known" };
    }
    return decideCacheWarm({
      view,
      nowMs: this.now(),
      lastAttemptMs: this.lastAttemptAt.get(agentId) ?? null,
    });
  }

  schedule(agentId: string): boolean {
    this.cancelTimerOnly(agentId);
    const decision = this.decide(agentId);
    if (decision.kind === "skip") {
      this.logger.debug({ agentId, reason: decision.reason }, "Cache warm not scheduled");
      return false;
    }
    const delayMs = decision.kind === "wait" ? decision.delayMs : 0;
    const scheduledEpoch = this.nextEpoch(agentId);
    const timeout = setTimeout(() => {
      void this.triggerPing(agentId, scheduledEpoch);
    }, delayMs);
    timeout.unref?.();
    this.activeTimers.set(agentId, {
      timeout,
      scheduledFor: new Date(this.now() + delayMs),
    });
    this.logger.debug({ agentId, delayMs }, "Cache warm scheduled from the last request");
    return true;
  }

  async triggerPing(agentId: string, expectedEpoch: number): Promise<boolean> {
    if (this.agentEpochs.get(agentId) !== expectedEpoch) {
      return false;
    }
    this.activeTimers.delete(agentId);

    const decision = this.decide(agentId);
    switch (decision.kind) {
      case "skip":
        this.logger.debug({ agentId, reason: decision.reason }, "Cache warm ping skipped");
        return false;
      case "wait":
        this.schedule(agentId);
        return false;
      case "interrupt-questions":
        return this.runAttempt({
          agentId,
          counts: decision,
          logMessage: "Closing an unanswered question",
          attempt: () => this.interruptPendingQuestions(agentId, decision.questions),
        });
      case "ping":
        return this.runAttempt({
          agentId,
          counts: decision,
          logMessage: "Warming prompt cache",
          attempt: () => this.sendCacheWarmPing(agentId),
        });
    }
  }

  private async runAttempt(input: {
    agentId: string;
    counts: { consecutivePings: number; maxPings: number };
    logMessage: string;
    attempt: () => Promise<boolean>;
  }): Promise<boolean> {
    const { agentId, counts, logMessage, attempt } = input;
    this.logger.info(
      { agentId, pingNumber: counts.consecutivePings + 1, maxPings: counts.maxPings },
      logMessage,
    );
    // Recorded as an attempt, not as a refresh: only the request's own message_start moves
    // the anchor, so a warm-up that never reaches Anthropic cannot pass for a warm cache.
    this.lastAttemptAt.set(agentId, this.now());
    this.pingsInFlight.add(agentId);
    let sent = false;
    try {
      sent = await attempt();
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "Cache warm attempt failed");
    } finally {
      this.pingsInFlight.delete(agentId);
    }
    // A failed attempt stays recorded, so the next decision stops this idle stretch instead
    // of retrying in a tight loop. Any new request moves the anchor past it and re-arms.
    if (sent) {
      // Published on its own: a warm-up reply can finish its turn before the send resolves,
      // so the turn's last state update would not carry the new counts.
      const consecutive = counts.consecutivePings + 1;
      this.consecutivePings.set(agentId, consecutive);
      this.agentManager.setCacheWarmCounts(
        agentId,
        {
          consecutiveWarmPings: consecutive,
          totalWarmPings: (this.agentManager.getAgent(agentId)?.totalWarmPings ?? 0) + 1,
        },
        { publish: true },
      );
    }
    return sent;
  }

  private async interruptPendingQuestions(
    agentId: string,
    pendingQuestions: AgentPermissionRequest[],
  ): Promise<boolean> {
    for (const question of pendingQuestions) {
      await this.agentManager.respondToPermission(agentId, question.id, {
        behavior: "deny",
        message: CACHE_WARM_QUESTION_PAUSE_MESSAGE,
      });
    }
    this.agentManager.markQuestionClosed(agentId);
    return true;
  }

  private async sendCacheWarmPing(agentId: string): Promise<boolean> {
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
    return result.disposition !== "skipped";
  }

  cancel(agentId: string): void {
    this.nextEpoch(agentId);
    this.cancelTimerOnly(agentId);
    this.dormantRecords.delete(agentId);
    this.resetConsecutivePings(agentId);
  }

  deleteAgent(agentId: string): void {
    this.cancel(agentId);
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
    this.lastAttemptAt.clear();
    this.dormantRecords.clear();
  }

  /**
   * Arms every warmable agent after boot: loaded ones, and idle ones that exist only on
   * disk. A warm-up for a dormant agent loads it through sendPromptToAgent.
   */
  async bootstrap(): Promise<void> {
    for (const agent of this.agentManager.listAgents()) {
      this.onAgentRegistered(agent.id, agent.consecutiveWarmPings);
      this.schedule(agent.id);
    }
    const records = await this.agentStorage.list();
    for (const record of records) {
      if (record.archivedAt || record.internal || this.agentManager.getAgent(record.id)) {
        continue;
      }
      if (resolveCacheWarmWindows(viewDormantRecord(record, 0)) === null) {
        continue;
      }
      this.dormantRecords.set(record.id, record);
      this.schedule(record.id);
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
