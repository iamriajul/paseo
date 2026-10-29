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
export const FIVE_MINUTE_CACHE_WARM_INTERVAL_MS = 4.5 * 60 * 1000;

export const ONE_HOUR_CACHE_WARM_MAX_PINGS = 12;
export const FIVE_MINUTE_CACHE_WARM_MAX_PINGS = 10;

export type PromptCacheTtl = "5m" | "1h";

/** Claude agent feature ids that carry the Cache window and the warm-up toggle. */
export const PROMPT_CACHE_TTL_FEATURE_ID = "prompt_cache_ttl";
export const CACHE_WARM_FEATURE_ID = "cache_warm";

/**
 * Longest foreground shell call Paseo lets a Claude agent make, per cache TTL. A main-thread
 * request can only refresh the cache once the call returns, so the 5m cap leaves the time the
 * request itself takes inside the window. It is a separate number from the 270 s warm interval.
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
  /** On a turn: time since the latest request that was not a warm-up, so time away. */
  awayMs?: number;
}

/**
 * Requests kept in the history. It rides on every agent snapshot, so it stays a recent window
 * of a few turns rather than the whole session.
 */
export const PROMPT_CACHE_HISTORY_LIMIT = 60;

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
}

function elapsedSinceMs(fromIso: string | undefined, toIso: string): number | null {
  const fromMs = fromIso ? new Date(fromIso).getTime() : Number.NaN;
  return Number.isFinite(fromMs) ? Math.max(0, new Date(toIso).getTime() - fromMs) : null;
}

function resolveRequestKind(sample: PromptCacheRequestSample, startsTurn: boolean) {
  if (sample.isWarmPing) return "warm-up";
  return startsTurn ? "turn" : "request";
}

/** Records one main-thread request into the cache state; pure so the daemon and tests share it. */
export function recordPromptCacheRequest(
  previous: AgentPromptCacheState | undefined,
  sample: PromptCacheRequestSample,
): AgentPromptCacheState {
  const startsTurn = !previous || previous.turnFirstRequest.turnId !== sample.turnId;
  const kind: PromptCacheRequestKind = resolveRequestKind(sample, startsTurn);
  const awayMs = kind === "turn" ? elapsedSinceMs(previous?.lastActivityAt, sample.at) : null;
  const entry: PromptCacheHistoryEntry = {
    at: sample.at,
    kind,
    readTokens: sample.readTokens,
    writeTokens: sample.writeTokens,
    uncachedTokens: sample.uncachedTokens,
    gapMs: elapsedSinceMs(previous?.lastRequest.at, sample.at),
    ...(awayMs === null ? {} : { awayMs }),
  };
  return {
    lastRequest: sample,
    turnFirstRequest: previous && !startsTurn ? previous.turnFirstRequest : sample,
    observedTtl: sample.writeTtl ?? previous?.observedTtl,
    questionClosedAt: previous?.questionClosedAt,
    lastActivityAt: sample.isWarmPing ? previous?.lastActivityAt : sample.at,
    history: [...(previous?.history ?? []), entry].slice(-PROMPT_CACHE_HISTORY_LIMIT),
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
