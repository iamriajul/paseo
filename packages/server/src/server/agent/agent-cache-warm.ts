import type { Logger } from "pino";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import {
  applyCacheWarmMaxPings,
  CACHE_AUTO_COMPACT_FEATURE_ID,
  CACHE_WARM_MAX_PINGS_FEATURE_ID,
  CACHE_AUTO_COMPACT_MIN_CONTEXT_TOKENS,
  CACHE_AUTO_COMPACT_PROMPT,
  promptCacheInputTokens,
  resolveCacheAutoCompactEnabled,
  DEFAULT_CACHE_WARM_PING_PROMPT,
  CACHE_WARM_QUESTION_PAUSE_MESSAGE,
  CACHE_WARM_PERMISSION_PAUSE_MESSAGE,
  resolveEffectivePromptCacheWindows,
  resolveCacheWarmEnabled,
  resolvePromptCacheAnchorMs,
  isCacheWarmPrompt,
  isCacheWarmReply,
  isClaudeModel,
  isQuestionPermission,
  isWarmUpPausedAtIdleCap,
  type CacheWarmStop,
  type CacheWarmStopReason,
  type PromptCacheTtl,
  type PromptCacheWindows,
} from "@getpaseo/protocol/agent-cache-warm";
import type { AgentCacheWarmPause } from "@getpaseo/protocol/messages";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentPermissionRequest } from "./agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import { sendPromptToAgent } from "./agent-prompt.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import type { WarmUpAccountBlock } from "./gateway/warm-up-account.js";
import {
  CLAUDE_CACHE_WARM_FEATURE_ID,
  CLAUDE_PROMPT_CACHE_TTL_FEATURE_ID,
} from "./providers/claude/feature-definitions.js";

export {
  DEFAULT_CACHE_WARM_PING_PROMPT,
  CACHE_WARM_QUESTION_PAUSE_MESSAGE,
  CACHE_WARM_PERMISSION_PAUSE_MESSAGE,
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
  /** Pending requests that are not questions: tool permissions such as a flagged command. */
  pendingPermissions: AgentPermissionRequest[];
  anchorMs: number | null;
  consecutivePings: number;
  /** Compact instead of expiring when the idle cap is reached. */
  autoCompact: boolean;
  /** Input of the latest request, so the context the cache holds; null before any request. */
  contextTokens: number | null;
  /** The session warms through a throwaway fork, so it needs no idle agent and sends it nothing. */
  forkWarm: boolean;
  /** Host setting `childReportExpiredCache` is keep-warm and a child can still report to it. */
  warmPastCap: boolean;
  /** Warm-up compacted at the idle cap; it resumes when the agent makes a request of its own. */
  pausedAtIdleCap: boolean;
  /** The serving account could not take a warm-up; it resumes on the agent's next request. */
  pausedForAccount: boolean;
  /** The account check went unanswered; no warm-up goes out before it reads again at this time. */
  accountRetryAtMs: number | null;
}

type CacheWarmDecision =
  /** `stop`: the warm-up stops for this idle stretch and leaves a still-warm cache to expire. */
  | { kind: "skip"; reason: string; stop?: CacheWarmStopReason }
  | { kind: "wait"; delayMs: number }
  | { kind: "ping"; consecutivePings: number; maxPings: number }
  | { kind: "fork-warm"; consecutivePings: number; maxPings: number }
  | { kind: "compact"; contextTokens: number }
  | {
      kind: "close-pending";
      questions: AgentPermissionRequest[];
      permissions: AgentPermissionRequest[];
      consecutivePings: number;
      maxPings: number;
    };

interface ViewInput {
  consecutivePings: number;
  pausedForAccount: boolean;
  accountRetryAtMs: number | null;
  /** The manager compacted this agent at the cap and nothing of its own ran since. */
  compactedAtCap: boolean;
  autoCompactByDefault: boolean;
  forkWarm: boolean;
  warmPastCap: boolean;
}

function readContextTokens(promptCache: ManagedAgent["promptCache"]): number | null {
  return promptCache ? promptCacheInputTokens(promptCache.lastRequest) : null;
}

function viewLiveAgent(
  agent: ManagedAgent,
  input: ViewInput & { hasInFlightRun: boolean },
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
    pendingPermissions: pending.filter((request) => !isQuestionPermission(request)),
    anchorMs: resolvePromptCacheAnchorMs(agent),
    consecutivePings: input.consecutivePings,
    autoCompact: resolveCacheAutoCompactEnabled({
      explicitValue: agent.config?.featureValues?.[CACHE_AUTO_COMPACT_FEATURE_ID],
      hostDefault: input.autoCompactByDefault,
    }),
    contextTokens: readContextTokens(agent.promptCache),
    forkWarm: input.forkWarm,
    warmPastCap: input.warmPastCap,
    pausedAtIdleCap: input.compactedAtCap || isWarmUpPausedAtIdleCap(agent.promptCache),
    pausedForAccount: input.pausedForAccount,
    accountRetryAtMs: input.accountRetryAtMs,
  };
}

function viewDormantRecord(record: StoredAgentRecord, input: ViewInput): CacheWarmView {
  // A record left "running" by a crash belongs to restart recovery, not to warm-up.
  const wasRunning = record.lastStatus === "running" || record.lastStatus === "initializing";
  return {
    provider: record.provider,
    modelId: record.config?.model ?? record.runtimeInfo?.model,
    featureValues: record.config?.featureValues ?? undefined,
    observedTtl: record.promptCache?.observedTtl,
    isDelegated: getParentAgentIdFromLabels(record.labels) !== null,
    activity: wasRunning ? "busy" : "ready",
    pendingQuestions: [],
    pendingPermissions: [],
    anchorMs: resolvePromptCacheAnchorMs(record),
    consecutivePings: input.consecutivePings,
    autoCompact: resolveCacheAutoCompactEnabled({
      explicitValue: record.config?.featureValues?.[CACHE_AUTO_COMPACT_FEATURE_ID],
      hostDefault: input.autoCompactByDefault,
    }),
    contextTokens: readContextTokens(record.promptCache),
    // Loading the record gives it a session that can fork; a crashed run is restart recovery's.
    forkWarm: input.forkWarm && !wasRunning,
    warmPastCap: input.warmPastCap,
    pausedAtIdleCap: input.compactedAtCap || isWarmUpPausedAtIdleCap(record.promptCache),
    pausedForAccount: input.pausedForAccount,
    accountRetryAtMs: input.accountRetryAtMs,
  };
}

/**
 * At the idle cap the cache would expire. Compacting while it is still warm reads the context at
 * the cache price and leaves a small one, so waking the agent later writes little. A small context
 * gains nothing from that and loses its detail.
 */
function reachedCap(view: CacheWarmView, windows: PromptCacheWindows): boolean {
  return !view.warmPastCap && view.consecutivePings >= windows.maxConsecutivePings;
}

function compactsAtCap(view: CacheWarmView): boolean {
  return (
    view.autoCompact &&
    view.contextTokens !== null &&
    view.contextTokens >= CACHE_AUTO_COMPACT_MIN_CONTEXT_TOKENS
  );
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
  const windows = enabled
    ? resolveEffectivePromptCacheWindows({ observedTtl: view.observedTtl, promptCacheTtl })
    : null;
  return windows
    ? applyCacheWarmMaxPings(windows, view.featureValues?.[CACHE_WARM_MAX_PINGS_FEATURE_ID])
    : null;
}

/** When the cache expires without another request, warm-up on or off; null without a window. */
function cacheExpiresAtMs(view: CacheWarmView): number | null {
  if (view.provider !== "claude" || view.anchorMs === null) return null;
  const windows = resolveEffectivePromptCacheWindows({
    observedTtl: view.observedTtl,
    promptCacheTtl: view.featureValues?.[CLAUDE_PROMPT_CACHE_TTL_FEATURE_ID],
  });
  return windows ? view.anchorMs + windows.cacheWindowMs : null;
}

type Warmable =
  | { kind: "warmable"; windows: PromptCacheWindows }
  | { kind: "skip"; reason: string };

/** Whether warm-up applies to the agent at all, before anything about its timing. */
function resolveWarmable(view: CacheWarmView): Warmable {
  if (view.activity === "closed") {
    return { kind: "skip", reason: "agent is closed" };
  }
  const windows = resolveCacheWarmWindows(view);
  if (!windows) {
    return { kind: "skip", reason: "warm-up is off or the cache window is Automatic" };
  }
  if (view.pausedAtIdleCap) {
    return { kind: "skip", reason: "paused after the idle-cap compaction until the next message" };
  }
  if (view.pausedForAccount) {
    return { kind: "skip", reason: "paused while the serving account is blocked" };
  }
  return { kind: "warmable", windows };
}

function decideCacheWarm(input: {
  view: CacheWarmView;
  nowMs: number;
  lastAttemptMs: number | null;
}): CacheWarmDecision {
  const decision = decideCacheWarmTiming(input);
  const retryAtMs = input.view.accountRetryAtMs;
  // An unanswered account check holds every send until it reads again.
  if (sendsRequest(decision) && retryAtMs !== null && retryAtMs > input.nowMs) {
    return { kind: "wait", delayMs: retryAtMs - input.nowMs };
  }
  return decision;
}

function decideCacheWarmTiming(input: {
  view: CacheWarmView;
  nowMs: number;
  lastAttemptMs: number | null;
}): CacheWarmDecision {
  const { view, nowMs, lastAttemptMs } = input;
  const warmable = resolveWarmable(view);
  if (warmable.kind === "skip") return warmable;
  const { windows } = warmable;
  if (view.forkWarm) {
    return decideForkWarm({ view, windows, nowMs, lastAttemptMs });
  }
  // A pending question or permission blocks the turn, so the ping could never go out. At the
  // deadline the watchdog closes it for the user who is away, and the turn ends.
  const hasPending = view.pendingQuestions.length + view.pendingPermissions.length > 0;
  if (hasPending && view.isDelegated) {
    return {
      kind: "skip",
      reason: "the parent agent answers this request",
      stop: "parent-answers",
    };
  }
  if (!hasPending && view.activity !== "ready") {
    return { kind: "skip", reason: "agent is busy" };
  }
  if (view.anchorMs === null) {
    return { kind: "skip", reason: "no request recorded yet" };
  }
  const elapsedMs = nowMs - view.anchorMs;
  if (elapsedMs >= windows.cacheWindowMs) {
    return { kind: "skip", reason: "cache has already expired" };
  }
  const capped = reachedCap(view, windows);
  if (capped && (!compactsAtCap(view) || hasPending)) {
    return { kind: "skip", reason: "auto-cap reached for this idle stretch", stop: "capped" };
  }
  if (lastAttemptMs !== null && lastAttemptMs > view.anchorMs) {
    return { kind: "skip", reason: "the last warm-up did not reach Anthropic", stop: "failed" };
  }
  if (elapsedMs < windows.warmIntervalMs) {
    return { kind: "wait", delayMs: windows.warmIntervalMs - elapsedMs };
  }
  if (capped) {
    return { kind: "compact", contextTokens: view.contextTokens ?? 0 };
  }
  const counts = {
    consecutivePings: view.consecutivePings,
    maxPings: windows.maxConsecutivePings,
  };
  return hasPending
    ? {
        kind: "close-pending",
        questions: view.pendingQuestions,
        permissions: view.pendingPermissions,
        ...counts,
      }
    : { kind: "ping", ...counts };
}

/**
 * A fork reaches the cache without the agent, so a running turn, a pending permission or an open
 * question is warmed like an idle agent. Only the idle-cap compaction is a turn, so it still needs
 * an idle agent with nothing pending; otherwise the cap lets the cache expire.
 */
function decideForkWarm(input: {
  view: CacheWarmView;
  windows: PromptCacheWindows;
  nowMs: number;
  lastAttemptMs: number | null;
}): CacheWarmDecision {
  const { view, windows, nowMs, lastAttemptMs } = input;
  if (view.anchorMs === null) {
    return { kind: "skip", reason: "no request recorded yet" };
  }
  const elapsedMs = nowMs - view.anchorMs;
  if (elapsedMs >= windows.cacheWindowMs) {
    return { kind: "skip", reason: "cache has already expired" };
  }
  const capped = reachedCap(view, windows);
  const canCompact =
    compactsAtCap(view) &&
    view.activity === "ready" &&
    view.pendingQuestions.length === 0 &&
    view.pendingPermissions.length === 0;
  if (capped && !canCompact) {
    return { kind: "skip", reason: "auto-cap reached for this idle stretch", stop: "capped" };
  }
  if (lastAttemptMs !== null && lastAttemptMs > view.anchorMs) {
    return { kind: "skip", reason: "the last warm-up did not reach Anthropic", stop: "failed" };
  }
  if (elapsedMs < windows.warmIntervalMs) {
    return { kind: "wait", delayMs: windows.warmIntervalMs - elapsedMs };
  }
  if (capped) {
    return { kind: "compact", contextTokens: view.contextTokens ?? 0 };
  }
  return {
    kind: "fork-warm",
    consecutivePings: view.consecutivePings,
    maxPings: windows.maxConsecutivePings,
  };
}

/** What a closed permission asked for, in the words the app shows and "Run it now" repeats. */
export function describeClosedPermission(request: AgentPermissionRequest): {
  tool: string;
  command?: string;
} {
  const input = request.input ?? {};
  const candidates = [input.command, input.file_path, input.url, request.title];
  const command = candidates.find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return command ? { tool: request.name, command } : { tool: request.name };
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
  /** Host setting `cacheAutoCompact`, read on every decision so a change applies at once. */
  isCacheAutoCompactByDefault?: () => boolean;
  /** Runs before an idle-cap compaction is sent; if it throws, the compaction is not sent. */
  onIdleCapCompaction?: (agentId: string) => Promise<void>;
  /** Loads an agent known only from storage, so its session can warm through a fork. */
  loadAgent?: (agentId: string) => Promise<unknown>;
  /**
   * Whether the idle cap is lifted for this agent: the host keeps an orchestrator warm while a child
   * it waits on can still report. Read on every decision so a setting change applies at once.
   */
  warmsPastCap?: (agentId: string) => boolean;
  /** Host setting `cacheWarmMode` is fork (v2); read on every decision so a change applies at once. */
  warmsThroughFork?: () => boolean;
  /**
   * Whether the CLIProxyAPI account serving the agent can take a warm-up, read right before one is
   * sent. Null when it can, or when the Gateway does not route the agent. A Gateway that cannot
   * confirm the account blocks too (see `readWarmUpAccountBlock`).
   */
  readAccountBlock?: (agentId: string) => Promise<WarmUpAccountBlock | null>;
}

/** How long an unanswered account check waits before it reads the Gateway again. */
export const WARM_UP_ACCOUNT_RETRY_MS = 20_000;

/** A retried check must leave a warm-up this long to reach Anthropic before the cache expires. */
const WARM_UP_ACCOUNT_RETRY_MARGIN_MS = 10_000;

function stopForBlock(block: WarmUpAccountBlock): Omit<CacheWarmStop, "at"> {
  return {
    reason: block.reason,
    ...(block.account ? { account: block.account } : {}),
    ...(block.until ? { until: block.until } : {}),
    ...(block.window ? { window: block.window } : {}),
  };
}

type SendingDecision = Extract<
  CacheWarmDecision,
  { kind: "ping" | "fork-warm" | "compact" | "close-pending" }
>;

/** Every decision that sends a request through the agent's session, so through its account. */
function sendsRequest(decision: CacheWarmDecision): decision is SendingDecision {
  return (
    decision.kind === "ping" ||
    decision.kind === "fork-warm" ||
    decision.kind === "compact" ||
    decision.kind === "close-pending"
  );
}

export class AgentCacheWarmManager {
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly logger: Logger;
  private readonly send: typeof sendPromptToAgent;
  private readonly loadAgent: (agentId: string) => Promise<unknown>;
  private readonly pingPrompt: string;
  private readonly now: () => number;
  private readonly isCacheAutoCompactByDefault: () => boolean;
  private readonly warmsPastCap: (agentId: string) => boolean;
  private readonly warmsThroughFork: () => boolean;
  private readonly readAccountBlock: (agentId: string) => Promise<WarmUpAccountBlock | null>;
  private idleCapCompactionHandler: ((agentId: string) => Promise<void>) | null;

  private readonly activeTimers = new Map<string, ActiveCacheWarmTimerEntry>();
  private readonly agentEpochs = new Map<string, number>();
  private readonly consecutivePings = new Map<string, number>();
  private readonly lastAttemptAt = new Map<string, number>();
  private readonly pingsInFlight = new Set<string>();
  /**
   * Compacted at the idle cap, until the agent's next request of its own. The compaction record in
   * the cache state says the same once it lands and survives a restart; this covers the turn
   * before it lands and a compaction that reported none.
   */
  private readonly compactedAtCap = new Set<string>();
  /** Agents known only from storage after a daemon restart, until something loads them. */
  private readonly dormantRecords = new Map<string, StoredAgentRecord>();
  /**
   * Paused because the serving account could not take a warm-up, until the agent's next request of
   * its own. The agent record carries the same pause, so it survives a restart.
   */
  private readonly accountPauses = new Map<string, AgentCacheWarmPause>();
  /** The anchor of the idle stretch whose stop was journaled, so a stretch records one stop. */
  private readonly stopRecordedFor = new Map<string, number>();

  constructor(dependencies: AgentCacheWarmManagerDependencies) {
    this.agentManager = dependencies.agentManager;
    this.agentStorage = dependencies.agentStorage;
    this.logger = dependencies.logger;
    this.send = dependencies.sendPrompt ?? sendPromptToAgent;
    this.loadAgent =
      dependencies.loadAgent ??
      ((agentId) =>
        ensureAgentLoaded(agentId, {
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          logger: this.logger,
        }));
    this.pingPrompt = dependencies.pingPrompt ?? DEFAULT_CACHE_WARM_PING_PROMPT;
    this.now = dependencies.now ?? (() => Date.now());
    this.isCacheAutoCompactByDefault = dependencies.isCacheAutoCompactByDefault ?? (() => false);
    this.warmsPastCap = dependencies.warmsPastCap ?? (() => false);
    this.warmsThroughFork = dependencies.warmsThroughFork ?? (() => true);
    this.readAccountBlock = dependencies.readAccountBlock ?? (async () => null);
    this.idleCapCompactionHandler = dependencies.onIdleCapCompaction ?? null;
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
    this.compactedAtCap.delete(agentId);
    this.clearAccountPause(agentId);
    this.setConsecutivePings(agentId, 0);
  }

  private pauseForAccount(agentId: string, pause: AgentCacheWarmPause): void {
    this.logger.info({ agentId, ...pause }, "Cache warm paused: the serving account cannot serve");
    this.accountPauses.set(agentId, pause);
    this.agentManager.setCacheWarmPause(agentId, pause);
  }

  /** The pause in memory, else the one the agent record kept across a restart. */
  private getAccountPause(agentId: string): AgentCacheWarmPause | null {
    return (
      this.accountPauses.get(agentId) ??
      this.agentManager.getAgent(agentId)?.cacheWarmPause ??
      this.dormantRecords.get(agentId)?.cacheWarmPause ??
      null
    );
  }

  private clearAccountPause(agentId: string): void {
    const paused = this.getAccountPause(agentId) !== null;
    this.accountPauses.delete(agentId);
    if (paused) this.agentManager.setCacheWarmPause(agentId, null);
  }

  /**
   * Journals why this idle stretch's warm-up stopped, once per stretch and only while the cache
   * is still warm: that is the expiry the warm-up let happen.
   */
  private recordStop(agentId: string, stop: Omit<CacheWarmStop, "at">): void {
    const view = this.viewAgent(agentId);
    const expiresAtMs = view ? cacheExpiresAtMs(view) : null;
    if (!view || view.anchorMs === null || expiresAtMs === null) return;
    if (expiresAtMs <= this.now() || this.stopRecordedFor.get(agentId) === view.anchorMs) return;
    this.stopRecordedFor.set(agentId, view.anchorMs);
    this.logger.info({ agentId, ...stop }, "Cache warm-up stopped; the cache is left to expire");
    this.agentManager.recordCacheWarmStop(agentId, {
      at: new Date(this.now()).toISOString(),
      ...stop,
    });
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

  onFeatureToggled(agentId: string, enabled: boolean): void {
    this.resetConsecutivePings(agentId);
    if (!enabled) this.recordStop(agentId, { reason: "off" });
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
    const pause = this.getAccountPause(agentId);
    const retryAtMs = pause?.retryAt ? Date.parse(pause.retryAt) : Number.NaN;
    const input: ViewInput = {
      consecutivePings: this.getConsecutivePings(agentId),
      pausedForAccount: pause !== null && !pause.retryAt,
      accountRetryAtMs: Number.isFinite(retryAtMs) ? retryAtMs : null,
      compactedAtCap: this.compactedAtCap.has(agentId),
      autoCompactByDefault: this.isCacheAutoCompactByDefault(),
      warmPastCap: this.warmsPastCap(agentId),
      forkWarm:
        this.warmsThroughFork() &&
        (agent
          ? this.agentManager.canWarmPromptCache(agentId)
          : this.dormantRecords.get(agentId)?.provider === "claude"),
    };
    if (agent) {
      return viewLiveAgent(agent, {
        ...input,
        hasInFlightRun: this.agentManager.hasInFlightRun?.(agentId) ?? false,
      });
    }
    const record = this.dormantRecords.get(agentId);
    return record ? viewDormantRecord(record, input) : null;
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
      if (decision.stop) this.recordStop(agentId, { reason: decision.stop });
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

    let decision = this.decide(agentId);
    if (sendsRequest(decision)) {
      const block = await this.checkAccount(agentId);
      // The read is a network call; anything that rescheduled meanwhile owns the agent now.
      if (this.agentEpochs.get(agentId) !== expectedEpoch) return false;
      if (block) {
        this.holdForAccount(agentId, block);
        return false;
      }
      // An earlier unanswered check is answered now. Clearing it publishes the agent, which can
      // arm a fresh warm-up; that one owns the agent then.
      if (this.getAccountPause(agentId)?.retryAt) {
        this.clearAccountPause(agentId);
        if (this.agentEpochs.get(agentId) !== expectedEpoch) return false;
      }
      // A turn may have started during the read; decide again on the agent as it is now.
      decision = this.decide(agentId);
    }
    switch (decision.kind) {
      case "skip":
        this.logger.debug({ agentId, reason: decision.reason }, "Cache warm ping skipped");
        if (decision.stop) this.recordStop(agentId, { reason: decision.stop });
        return false;
      case "wait":
        this.schedule(agentId);
        return false;
      case "close-pending":
        return this.runAttempt({
          agentId,
          counts: decision,
          logMessage: "Closing an unanswered question or permission",
          attempt: () => this.closePendingRequests(agentId, decision),
        });
      case "ping":
        return this.runAttempt({
          agentId,
          counts: decision,
          logMessage: "Warming prompt cache",
          attempt: () => this.sendCacheWarmPing(agentId),
        });
      case "fork-warm": {
        const warmed = await this.runAttempt({
          agentId,
          counts: decision,
          logMessage: "Warming prompt cache through a fork",
          attempt: () => this.warmThroughFork(agentId),
        });
        // No turn follows a fork, so nothing else times the next warm-up.
        if (warmed) this.schedule(agentId);
        return warmed;
      }
      case "compact":
        return this.compactAtCap(agentId, decision.contextTokens);
    }
  }

  /**
   * A check that throws is unconfirmed, like a Gateway that does not answer: nothing goes out
   * unchecked (the user's rule, 2026-11-11). Until then a failed read warmed anyway.
   */
  private async checkAccount(agentId: string): Promise<WarmUpAccountBlock | null> {
    try {
      return await this.readAccountBlock(agentId);
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "Warm-up account check failed; not warming");
      return { reason: "unconfirmed", account: "" };
    }
  }

  /**
   * Holds the warm-up the account cannot take. A Gateway that did not answer gets another read
   * while a warm-up after it can still reach the cache in time; the pause says when, and the
   * cache is not given up yet. Anything else, and an unanswered read with no time left, pauses
   * until the agent's next request of its own and journals why the cache was left to expire.
   */
  private holdForAccount(agentId: string, block: WarmUpAccountBlock): void {
    const view = this.viewAgent(agentId);
    const expiresAtMs = view ? cacheExpiresAtMs(view) : null;
    const retryAtMs = this.now() + WARM_UP_ACCOUNT_RETRY_MS;
    if (
      block.reason === "unconfirmed" &&
      expiresAtMs !== null &&
      retryAtMs + WARM_UP_ACCOUNT_RETRY_MARGIN_MS < expiresAtMs
    ) {
      this.pauseForAccount(agentId, { ...block, retryAt: new Date(retryAtMs).toISOString() });
      this.schedule(agentId);
      return;
    }
    const { retryAt: _retryAt, ...pause } = block;
    this.recordStop(agentId, stopForBlock(pause));
    this.pauseForAccount(agentId, pause);
  }

  /** Set once the schedule service exists, which bootstrap builds after this manager. */
  setIdleCapCompactionHandler(handler: (agentId: string) => Promise<void>): void {
    this.idleCapCompactionHandler = handler;
  }

  /**
   * Compacts instead of letting the cache expire, then pauses warm-up until the agent's next
   * request of its own: the compacted context is cheap to write again, so keeping it warm would
   * cost more than it saves. Warm-up stays on, so the next message resumes it with a fresh count.
   * It is no warm-up, so the ping counts stay as they are.
   */
  private async compactAtCap(agentId: string, contextTokens: number): Promise<boolean> {
    this.logger.info({ agentId, contextTokens }, "Compacting at the warm-up idle cap");
    this.lastAttemptAt.set(agentId, this.now());
    this.pingsInFlight.add(agentId);
    let sent = false;
    try {
      // Before the compaction turn, so no heartbeat or schedule can wake the session after it.
      await this.idleCapCompactionHandler?.(agentId);
      sent = await this.sendPrompt(agentId, CACHE_AUTO_COMPACT_PROMPT);
      if (sent) this.compactedAtCap.add(agentId);
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "Idle-cap compaction failed");
    } finally {
      this.pingsInFlight.delete(agentId);
    }
    return sent;
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
    if (!sent) this.recordStop(agentId, { reason: "failed" });
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

  /**
   * Answers for the user who is away: denies each pending question and permission so the turn
   * ends, and records what was closed so the app can show it and offer to run it.
   */
  private async closePendingRequests(
    agentId: string,
    pending: { questions: AgentPermissionRequest[]; permissions: AgentPermissionRequest[] },
  ): Promise<boolean> {
    for (const question of pending.questions) {
      await this.agentManager.respondToPermission(agentId, question.id, {
        behavior: "deny",
        message: CACHE_WARM_QUESTION_PAUSE_MESSAGE,
      });
    }
    for (const permission of pending.permissions) {
      await this.agentManager.respondToPermission(agentId, permission.id, {
        behavior: "deny",
        message: CACHE_WARM_PERMISSION_PAUSE_MESSAGE,
      });
    }
    if (pending.questions.length > 0) this.agentManager.markQuestionClosed(agentId);
    // The banner names only the newest closed permission, on purpose. A turn waits on one
    // permission at a time except for parallel tool calls, whose other denials stay in the
    // transcript, and Run it now's go-ahead covers the whole step. A later close replaces an
    // earlier record because only the newest still matches what the agent stopped on.
    const closedPermission = pending.permissions.at(-1);
    if (closedPermission) {
      this.agentManager.markPermissionClosed(agentId, describeClosedPermission(closedPermission));
    }
    return true;
  }

  private async warmThroughFork(agentId: string): Promise<boolean> {
    if (!this.agentManager.getAgent(agentId)) await this.loadAgent(agentId);
    return this.agentManager.warmPromptCache(agentId);
  }

  /** A request of the agent's own restarts the TTL and ends the idle stretch's warm-up count. */
  onRequestRecorded(agentId: string): void {
    if (this.getConsecutivePings(agentId) > 0) this.resetConsecutivePings(agentId);
    else {
      this.lastAttemptAt.delete(agentId);
      this.compactedAtCap.delete(agentId);
      this.clearAccountPause(agentId);
    }
    this.schedule(agentId);
  }

  private sendCacheWarmPing(agentId: string): Promise<boolean> {
    return this.sendPrompt(agentId, this.pingPrompt, { lowestWarmUpEffort: true });
  }

  /** Sent as a warm-up turn so it raises no attention and keeps the idle-stretch counts. */
  private async sendPrompt(
    agentId: string,
    prompt: string,
    options?: { lowestWarmUpEffort: true },
  ): Promise<boolean> {
    const result = await this.send({
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      agentId,
      prompt,
      replaceRunning: false,
      unarchive: false,
      logger: this.logger,
      runOptions: {
        isWarmPing: true,
        ...options,
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
    this.stopRecordedFor.delete(agentId);
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
    this.compactedAtCap.clear();
    for (const agentId of Array.from(this.accountPauses.keys())) this.clearAccountPause(agentId);
    this.dormantRecords.clear();
  }

  /**
   * Arms every warmable agent after boot: loaded ones, and idle ones that exist only on
   * disk. A warm-up for a dormant agent loads it (`loadAgent`) and then warms it through a fork.
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
      const view = viewDormantRecord(record, {
        consecutivePings: 0,
        pausedForAccount: false,
        accountRetryAtMs: null,
        compactedAtCap: false,
        autoCompactByDefault: false,
        forkWarm: false,
        warmPastCap: false,
      });
      if (resolveCacheWarmWindows(view) === null) {
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
