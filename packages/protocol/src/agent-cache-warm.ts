export const DEFAULT_CACHE_WARM_PING_PROMPT =
  "AFK for a bit, keeping you alive. Reply with 'ok' only.";

/**
 * Tool result for a question warm-up closed. It reaches the model, the transcript and the UI,
 * so it names no cache, warm-up or pings. It is written in the user's own voice: they say they
 * are away and tell the model how to ask again.
 */
export const CACHE_WARM_QUESTION_PAUSE_MESSAGE =
  "I'm AFK and couldn't answer this question. Stop here. When I'm back and write again, use my answer if it gives one. Otherwise, ask the question again with the same options.";

export const ONE_HOUR_CACHE_WINDOW_MS = 60 * 60 * 1000;
export const FIVE_MINUTE_CACHE_WINDOW_MS = 5 * 60 * 1000;

export const ONE_HOUR_CACHE_WARM_INTERVAL_MS = 58 * 60 * 1000;
/**
 * 4 minutes leaves a minute for the ping to reach Anthropic: it goes through Claude Code, its
 * prompt hooks and the request's start on a large context. Measured: pings fired at 270 s began
 * 289-290 s after the last request on a 500k context, and some only at 314-322 s.
 */
export const FIVE_MINUTE_CACHE_WARM_INTERVAL_MS = 4 * 60 * 1000;

export const ONE_HOUR_CACHE_WARM_MAX_PINGS = 12;
export const FIVE_MINUTE_CACHE_WARM_MAX_PINGS = 10;

export type PromptCacheTtl = "5m" | "1h";

/** Claude agent feature ids that carry the Cache window and the warm-up toggle. */
export const PROMPT_CACHE_TTL_FEATURE_ID = "prompt_cache_ttl";
export const CACHE_WARM_FEATURE_ID = "cache_warm";
/**
 * Per-agent override for compacting at the warm-up idle cap. It is stored in featureValues but not
 * listed as a provider feature: the pill owns the switch, and an unset value follows the host's
 * `cacheAutoCompact` default, which the provider cannot see.
 */
export const CACHE_AUTO_COMPACT_FEATURE_ID = "cache_auto_compact";

/**
 * Below this the context is too small for a compaction to pay: a fresh Claude Code session already
 * starts near 60k tokens, so compacting 150k saves little and loses the detail.
 */
export const CACHE_AUTO_COMPACT_MIN_CONTEXT_TOKENS = 200_000;

export const CACHE_AUTO_COMPACT_PROMPT = "/compact";

export function resolveCacheAutoCompactEnabled(input: {
  explicitValue: unknown;
  hostDefault: boolean | undefined;
}): boolean {
  return typeof input.explicitValue === "boolean"
    ? input.explicitValue
    : input.hostDefault === true;
}

/**
 * Longest foreground shell call Paseo lets a Claude agent make, per cache TTL. A main-thread
 * request can only refresh the cache once the call returns, so the 5m cap leaves the time the
 * request itself takes inside the window. It is a separate number from the 240 s warm interval.
 */
export const FOREGROUND_SHELL_CAP_MS: Record<PromptCacheTtl, number> = {
  "5m": 250_000,
  "1h": 58 * 60 * 1000,
};

export interface PromptCacheWindows {
  cacheWindowMs: number;
  warmIntervalMs: number;
  maxConsecutivePings: number;
}

const PROMPT_CACHE_WINDOWS: Record<PromptCacheTtl, PromptCacheWindows> = {
  "5m": {
    cacheWindowMs: FIVE_MINUTE_CACHE_WINDOW_MS,
    warmIntervalMs: FIVE_MINUTE_CACHE_WARM_INTERVAL_MS,
    maxConsecutivePings: FIVE_MINUTE_CACHE_WARM_MAX_PINGS,
  },
  "1h": {
    cacheWindowMs: ONE_HOUR_CACHE_WINDOW_MS,
    warmIntervalMs: ONE_HOUR_CACHE_WARM_INTERVAL_MS,
    maxConsecutivePings: ONE_HOUR_CACHE_WARM_MAX_PINGS,
  },
};

/**
 * Windows for an explicitly chosen Cache window. "Automatic" (or unset) returns null:
 * Claude Code then picks 1h or 5m from auth, overage and gateway routing, which Paseo only
 * learns from a cache write after the fact, so warm-up needs an explicit choice.
 */
export function resolvePromptCacheWindows(promptCacheTtl: unknown): PromptCacheWindows | null {
  return isPromptCacheTtl(promptCacheTtl) ? PROMPT_CACHE_WINDOWS[promptCacheTtl] : null;
}

export function isPromptCacheTtl(value: unknown): value is PromptCacheTtl {
  return value === "5m" || value === "1h";
}

export interface EffectivePromptCacheTtl {
  ttl: PromptCacheTtl;
  /**
   * observed: the latest cache write was billed at this TTL, so the running process uses it.
   * configured: nothing observed yet, the Cache window names it.
   * assumed: Automatic and nothing observed; 5m is the safe guess, because treating a 5m
   * cache as 1h lets it expire unseen, while the reverse only costs a stricter cap.
   */
  source: "observed" | "configured" | "assumed";
}

/**
 * The observed TTL comes first because a Cache window change only reaches Claude Code when its
 * process relaunches, and "Automatic" is Claude Code's choice, which Paseo only sees in writes.
 */
export function resolveEffectivePromptCacheTtl(input: {
  observedTtl: PromptCacheTtl | null | undefined;
  promptCacheTtl: unknown;
}): EffectivePromptCacheTtl {
  if (input.observedTtl) {
    return { ttl: input.observedTtl, source: "observed" };
  }
  if (isPromptCacheTtl(input.promptCacheTtl)) {
    return { ttl: input.promptCacheTtl, source: "configured" };
  }
  return { ttl: "5m", source: "assumed" };
}

/** Windows the cache really runs on, or null while Automatic and nothing has been observed. */
export function resolveEffectivePromptCacheWindows(input: {
  observedTtl: PromptCacheTtl | null | undefined;
  promptCacheTtl: unknown;
}): PromptCacheWindows | null {
  const effective = resolveEffectivePromptCacheTtl(input);
  return effective.source === "assumed" ? null : PROMPT_CACHE_WINDOWS[effective.ttl];
}

export function resolveCacheWarmEnabled(input: {
  promptCacheTtl: unknown;
  explicitValue: unknown;
}): boolean {
  if (resolvePromptCacheWindows(input.promptCacheTtl) === null) {
    return false;
  }
  if (typeof input.explicitValue === "boolean") {
    return input.explicitValue;
  }
  return input.promptCacheTtl === "5m";
}

export interface PromptCacheRequestTokens {
  readTokens: number;
  writeTokens: number;
  uncachedTokens: number;
  /** TTL the request's cache write was billed at; absent when it wrote nothing at a known TTL. */
  writeTtl?: PromptCacheTtl;
}

/** One main-thread Anthropic request, stamped when its `message_start` arrived. */
export interface PromptCacheRequestSample extends PromptCacheRequestTokens {
  at: string;
  turnId: string | null;
  isWarmPing: boolean;
  /** Model the agent ran on when the request went out; absent on samples written before it. */
  model?: string;
}

/**
 * turn: the first request of a turn, sent when the user or the agent itself starts one.
 * request: a later request in the same turn, sent once a tool call returns.
 * warm-up: a warm-up ping.
 */
export type PromptCacheRequestKind = "turn" | "request" | "warm-up";

/** How one main-thread request met the cache. Each request reads or writes on its own. */
export interface PromptCacheHistoryEntry {
  at: string;
  kind: PromptCacheRequestKind;
  readTokens: number;
  writeTokens: number;
  uncachedTokens: number;
  /** Time since the previous main-thread request; null for the agent's first request. */
  gapMs: number | null;
  /**
   * TTL the request's cache write was billed at, and the model it ran on, so each request can be
   * priced on its own: a session switches models (a Haiku compaction) and windows. Absent on
   * entries written before they were recorded.
   */
  writeTtl?: PromptCacheTtl;
  model?: string;
  /** On a turn: time since the latest request that was not a warm-up, so time away. */
  awayMs?: number;
  /** First request after a compaction: it has to write the new context, so it is no miss. */
  afterCompaction?: boolean;
  /**
   * Input of the request this one is measured against: the previous request, or for a native
   * fork's first request, the context it inherited. Absent on a fresh session's first request.
   */
  previousInputTokens?: number;
}

/**
 * Requests kept in the snapshot history. It rides on every agent snapshot, so it stays the few
 * bars the pill draws; the whole session lives in the daemon's journal and is fetched on demand
 * with `agent.prompt_cache.history.request`.
 */
export const PROMPT_CACHE_HISTORY_LIMIT = 24;

/** Compactions kept on the snapshot, for the same reason as the history limit. */
export const PROMPT_CACHE_COMPACTION_LIMIT = 10;

/**
 * Share of its own input a request must read to count as a hit. Only records written before
 * previousInputTokens existed use it; the protocol does not judge new requests by their own input.
 */
export const PROMPT_CACHE_HIT_RATIO = 0.5;

/**
 * Share of the previous request's input that a later request must read to count as a hit. The
 * cache holds what the previous request sent, so a request that reads all of it is a hit even
 * when it appends a large tool result, which is written and not read. It is 90%, not 50%,
 * because a request after an expiry can still read the shared system prefix, which is most of a
 * small context.
 */
export const PROMPT_CACHE_PREVIOUS_READ_RATIO = 0.9;

/** One context compaction, whoever asked for it. */
export interface PromptCacheCompaction {
  at: string;
  /** manual: someone sent /compact (Paseo's idle-cap compaction included); auto: Claude Code. */
  trigger: "manual" | "auto";
  /** Context size before the compaction, when Claude Code reported it. */
  preTokens?: number;
  /** Paseo compacted at the warm-up idle cap instead of letting the cache expire. */
  atIdleCap?: boolean;
}

/** Whole-session tallies; the snapshot history is only a window, these never roll off. */
export interface PromptCacheTotals {
  /**
   * Requests that had a cache to hit: not a fresh session's first request, not one after a
   * compaction.
   */
  requests: number;
  hits: number;
  /**
   * Misses a warm cache could have avoided: not a fresh session's first request, not right after
   * a compaction.
   */
  misses: number;
}

export interface AgentPromptCacheState {
  lastRequest: PromptCacheRequestSample;
  /** First request of the latest turn: the one that answers "did my prompt hit the cache". */
  turnFirstRequest: PromptCacheRequestSample;
  /** TTL of the latest request that wrote to the cache; it outlives requests that only read. */
  observedTtl?: PromptCacheTtl;
  /** When warm-up closed the user's unanswered question; cleared by the user's next message. */
  questionClosedAt?: string;
  /** Latest request that was not a warm-up: where the next turn's time away starts. */
  lastActivityAt?: string;
  /** Oldest first, at most PROMPT_CACHE_HISTORY_LIMIT entries. */
  history?: PromptCacheHistoryEntry[];
  /** Oldest first, at most PROMPT_CACHE_COMPACTION_LIMIT entries. */
  compactions?: PromptCacheCompaction[];
  /** Absent on records written before totals existed until their next request. */
  totals?: PromptCacheTotals;
  /**
   * The session's miss total when the user cleared the red count. The count shows misses since;
   * insights keep reading the full totals and journal.
   */
  missesCleared?: PromptCacheMissesCleared;
}

export interface PromptCacheMissesCleared {
  at: string;
  misses: number;
}

/** Misses since the user last cleared the count: the red number in the pill and sidebar. */
export function visiblePromptCacheMisses(
  totals: Pick<PromptCacheTotals, "misses">,
  cleared: PromptCacheMissesCleared | undefined,
): number {
  return Math.max(0, totals.misses - (cleared?.misses ?? 0));
}

/**
 * A hit reads the context the previous request left in the cache. A fresh session's first request
 * has no earlier request to read, so it never hits, even when the API reports a shared-prefix
 * read. A native fork's first request is measured against the context it inherited.
 */
export function isPromptCacheHit(
  entry: PromptCacheRequestTokens & Pick<PromptCacheHistoryEntry, "gapMs" | "previousInputTokens">,
): boolean {
  if (entry.gapMs === null) return false;
  if (entry.previousInputTokens !== undefined) {
    return entry.readTokens >= PROMPT_CACHE_PREVIOUS_READ_RATIO * entry.previousInputTokens;
  }
  return (promptCacheHitRatio(entry) ?? 0) >= PROMPT_CACHE_HIT_RATIO;
}

/**
 * The first request after a compaction. The compacted context was never cached, so it cannot hit
 * and it is not a miss. The counts and charts leave it out entirely; the compaction itself shows.
 */
export function isUncountedPromptCacheRequest(
  entry: Pick<PromptCacheHistoryEntry, "afterCompaction">,
): boolean {
  return entry.afterCompaction === true;
}

/**
 * A miss worth a red number: the request came after cached context and did not read it. A fresh
 * session's first request has no context before it, and the first request after a compaction
 * writes context that was never cached, so neither is a miss.
 */
export function isAvoidablePromptCacheMiss(entry: PromptCacheHistoryEntry): boolean {
  return entry.gapMs !== null && !entry.afterCompaction && !isPromptCacheHit(entry);
}

function addToTotals(totals: PromptCacheTotals, entry: PromptCacheHistoryEntry): PromptCacheTotals {
  // Neither the agent's first request nor the first after a compaction had a cache to hit.
  if (isUncountedPromptCacheRequest(entry) || entry.gapMs === null) return totals;
  return {
    requests: totals.requests + 1,
    hits: totals.hits + (isPromptCacheHit(entry) ? 1 : 0),
    misses: totals.misses + (isAvoidablePromptCacheMiss(entry) ? 1 : 0),
  };
}

const EMPTY_TOTALS: PromptCacheTotals = { requests: 0, hits: 0, misses: 0 };

/** Tallies a run of entries; also seeds totals for records written before they existed. */
export function sumPromptCacheTotals(
  entries: readonly PromptCacheHistoryEntry[],
): PromptCacheTotals {
  return entries.reduce(addToTotals, EMPTY_TOTALS);
}

/** Input tokens of one request: the context the model read, so the session's size at that point. */
export function promptCacheInputTokens(tokens: PromptCacheRequestTokens): number {
  return tokens.readTokens + tokens.writeTokens + tokens.uncachedTokens;
}

function elapsedSinceMs(fromIso: string | undefined, toIso: string): number | null {
  const fromMs = fromIso ? new Date(fromIso).getTime() : Number.NaN;
  return Number.isFinite(fromMs) ? Math.max(0, new Date(toIso).getTime() - fromMs) : null;
}

function resolveRequestKind(sample: PromptCacheRequestSample, startsTurn: boolean) {
  if (sample.isWarmPing) return "warm-up";
  return startsTurn ? "turn" : "request";
}

/** A compaction landed since the previous request, so this one writes the compacted context. */
function followsCompaction(previous: AgentPromptCacheState | undefined): boolean {
  const lastCompactionAt = previous?.compactions?.at(-1)?.at;
  return lastCompactionAt !== undefined && lastCompactionAt >= (previous?.lastRequest.at ?? "");
}

/**
 * The context a native fork inherits from its parent: the parent's last request before the fork.
 * The fork reads that context from the cache, so its first request is measured against it.
 */
export interface PromptCacheInheritance {
  at: string;
  inputTokens: number;
}

function buildHistoryEntry(
  previous: AgentPromptCacheState | undefined,
  sample: PromptCacheRequestSample,
  startsTurn: boolean,
  inherited: PromptCacheInheritance | undefined,
): PromptCacheHistoryEntry {
  const kind: PromptCacheRequestKind = resolveRequestKind(sample, startsTurn);
  // The request this one is measured against: the previous request, else what a fork inherited.
  const basisAt = previous?.lastRequest.at ?? inherited?.at;
  const basisActivityAt = previous?.lastActivityAt ?? inherited?.at;
  const previousInputTokens = previous
    ? promptCacheInputTokens(previous.lastRequest)
    : (inherited?.inputTokens ?? 0);
  const awayMs = kind === "turn" ? elapsedSinceMs(basisActivityAt, sample.at) : null;
  const afterCompaction = followsCompaction(previous);
  return {
    at: sample.at,
    kind,
    readTokens: sample.readTokens,
    writeTokens: sample.writeTokens,
    uncachedTokens: sample.uncachedTokens,
    gapMs: elapsedSinceMs(basisAt, sample.at),
    ...(sample.writeTtl ? { writeTtl: sample.writeTtl } : {}),
    ...(sample.model ? { model: sample.model } : {}),
    ...(awayMs === null ? {} : { awayMs }),
    ...(afterCompaction ? { afterCompaction: true } : {}),
    ...(previousInputTokens > 0 ? { previousInputTokens } : {}),
  };
}

/** Records one main-thread request into the cache state; pure so the daemon and tests share it. */
export function recordPromptCacheRequest(
  previous: AgentPromptCacheState | undefined,
  sample: PromptCacheRequestSample,
  inherited?: PromptCacheInheritance,
): AgentPromptCacheState {
  // A warm-up belongs to no turn: it can land in the middle of one, and the agent's next request
  // there still continues that turn.
  const startsTurn =
    !previous || (!sample.isWarmPing && previous.turnFirstRequest.turnId !== sample.turnId);
  const entry = buildHistoryEntry(previous, sample, startsTurn, inherited);
  const priorTotals = previous?.totals ?? sumPromptCacheTotals(previous?.history ?? []);
  return {
    lastRequest: sample,
    turnFirstRequest: previous && !startsTurn ? previous.turnFirstRequest : sample,
    observedTtl: sample.writeTtl ?? previous?.observedTtl,
    questionClosedAt: previous?.questionClosedAt,
    lastActivityAt: sample.isWarmPing ? previous?.lastActivityAt : sample.at,
    history: [...(previous?.history ?? []), entry].slice(-PROMPT_CACHE_HISTORY_LIMIT),
    compactions: previous?.compactions,
    totals: addToTotals(priorTotals, entry),
    missesCleared: previous?.missesCleared,
  };
}

/** Last entry recordPromptCacheRequest appended; the daemon journals it. */
export function latestPromptCacheEntry(
  state: AgentPromptCacheState,
): PromptCacheHistoryEntry | undefined {
  return state.history?.at(-1);
}

/**
 * Records a compaction. Without a request on record there is no cache state to attach it to,
 * and the next request is the agent's first anyway, so nothing is lost.
 */
export function recordPromptCacheCompaction(
  previous: AgentPromptCacheState | undefined,
  compaction: PromptCacheCompaction,
): AgentPromptCacheState | undefined {
  if (!previous) return undefined;
  return {
    ...previous,
    compactions: [...(previous.compactions ?? []), compaction].slice(
      -PROMPT_CACHE_COMPACTION_LIMIT,
    ),
  };
}

/**
 * Anthropic restarts the cache TTL when a request is processed, not when the turn ends.
 * A turn makes many requests, so the latest request start is the anchor; turn end is
 * only the fallback for records written before request samples existed.
 */
export function resolvePromptCacheAnchorMs(input: {
  promptCache?: { lastRequest: { at: string } } | null;
  lastResponseAt?: Date | string | null;
}): number | null {
  const requestAt = input.promptCache?.lastRequest.at;
  const source = requestAt ?? input.lastResponseAt ?? null;
  if (source === null) {
    return null;
  }
  const ms = new Date(source).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function promptCacheHitRatio(sample: PromptCacheRequestTokens): number | null {
  const total = sample.readTokens + sample.writeTokens + sample.uncachedTokens;
  return total > 0 ? sample.readTokens / total : null;
}

export function isCacheWarmPrompt(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.trim() === DEFAULT_CACHE_WARM_PING_PROMPT;
}

export function isCacheWarmReply(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text.trim().toLowerCase();
  return normalized === "ok" || normalized === "ok." || normalized === "ok!";
}

export const CLAUDE_FAMILY_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);

export function isClaudeModel(modelId: string | null | undefined): boolean {
  if (!modelId) return true;
  const trimmed = modelId.trim().toLowerCase();
  if (trimmed.includes("-dd-")) {
    return false;
  }
  const bareModel = trimmed.split("/").pop() ?? "";
  if (CLAUDE_FAMILY_ALIASES.has(bareModel)) {
    return true;
  }
  const stripped = bareModel.replace(/^(?:us|eu|asia|ap)\.anthropic\./, "");
  return stripped.startsWith("claude");
}

export function isQuestionPermission(permission: {
  kind?: string | null;
  name?: string | null;
}): boolean {
  return permission.kind === "question" || permission.name === "AskUserQuestion";
}

/**
 * Host setting `cacheExpiryStop`: what the daemon does once a Claude agent's cache expires.
 * Claude's own cron and wake-up timers and its task notifications run inside the Claude process,
 * so stopping the process is the only way to keep them from waking the agent cold.
 * when-idle: stop the process unless a background task is still running.
 * always: stop it, background tasks included.
 * off: leave it running.
 */
export const CACHE_EXPIRY_STOP_POLICIES = ["when-idle", "always", "off"] as const;
export type CacheExpiryStopPolicy = (typeof CACHE_EXPIRY_STOP_POLICIES)[number];
export const DEFAULT_CACHE_EXPIRY_STOP_POLICY: CacheExpiryStopPolicy = "when-idle";

export function resolveCacheExpiryStopPolicy(value: unknown): CacheExpiryStopPolicy {
  return (CACHE_EXPIRY_STOP_POLICIES as readonly unknown[]).includes(value)
    ? (value as CacheExpiryStopPolicy)
    : DEFAULT_CACHE_EXPIRY_STOP_POLICY;
}

/**
 * Host setting `cacheWarmMode`: how warm-up reaches the cache.
 * ping (v1, default): a short turn sent to the agent, so it needs an idle agent and leaves the ping
 * and its reply in the transcript.
 * fork (v2, experimental): a throwaway fork of the session sends one request, so running and
 * blocked agents warm too and nothing reaches the transcript. The fork sends the session's own ID
 * in X-Claude-Code-Session-Id, so a gateway that keeps sessions sticky to accounts routes it to
 * the account that holds the session's cache.
 */
export const CACHE_WARM_MODES = ["ping", "fork"] as const;
export type CacheWarmMode = (typeof CACHE_WARM_MODES)[number];
export const DEFAULT_CACHE_WARM_MODE: CacheWarmMode = "ping";

export function resolveCacheWarmMode(value: unknown): CacheWarmMode {
  return (CACHE_WARM_MODES as readonly unknown[]).includes(value)
    ? (value as CacheWarmMode)
    : DEFAULT_CACHE_WARM_MODE;
}

/**
 * Host setting `childReportExpiredCache`: what a child agent's report does to an orchestrator whose
 * cache has expired. A report is a prompt, so delivering it to a cold orchestrator writes its whole
 * context again at full price.
 * wake: deliver it now; the orchestrator wakes and writes its context again.
 * hold: keep it and deliver it into the orchestrator's next turn; the report itself never wakes it.
 * keep-warm: keep warming the orchestrator past the idle cap while a child it waits on can still
 * report, so the report lands in a warm cache. One long child keeps a large context warm all night.
 */
export const CHILD_REPORT_EXPIRED_CACHE_POLICIES = ["wake", "hold", "keep-warm"] as const;
export type ChildReportExpiredCachePolicy = (typeof CHILD_REPORT_EXPIRED_CACHE_POLICIES)[number];
export const DEFAULT_CHILD_REPORT_EXPIRED_CACHE_POLICY: ChildReportExpiredCachePolicy = "wake";

export function resolveChildReportExpiredCachePolicy(
  value: unknown,
): ChildReportExpiredCachePolicy {
  return (CHILD_REPORT_EXPIRED_CACHE_POLICIES as readonly unknown[]).includes(value)
    ? (value as ChildReportExpiredCachePolicy)
    : DEFAULT_CHILD_REPORT_EXPIRED_CACHE_POLICY;
}

/**
 * When a Claude agent's cache expires, or null when that is not known: another provider or model,
 * the Automatic Cache window (Claude Code picks the TTL), or no request yet.
 */
export function resolvePromptCacheExpiresAtMs(input: {
  provider: string;
  modelId: string | null | undefined;
  promptCacheTtl: unknown;
  observedTtl: PromptCacheTtl | null | undefined;
  anchorMs: number | null;
}): number | null {
  if (input.provider !== "claude" || !isClaudeModel(input.modelId)) return null;
  if (input.anchorMs === null || resolvePromptCacheWindows(input.promptCacheTtl) === null) {
    return null;
  }
  const windows = resolveEffectivePromptCacheWindows({
    observedTtl: input.observedTtl,
    promptCacheTtl: input.promptCacheTtl,
  });
  return windows ? input.anchorMs + windows.cacheWindowMs : null;
}
