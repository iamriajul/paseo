export const DEFAULT_CACHE_WARM_PING_PROMPT =
  "AFK for a bit, keeping you alive. Reply with 'ok' only.";

export const CACHE_WARM_QUESTION_PAUSE_MESSAGE =
  "The user is temporarily away (AFK). This question was automatically paused to preserve the prompt cache. Stand by and do not perform any other actions. When the user returns and sends a message:\n" +
  "- If the user provides the answer to the question directly, proceed using their answer.\n" +
  "- Otherwise (e.g. they say 'I am back', 'continue', 'ready', etc.), immediately call AskUserQuestion again with the exact question and options so they can answer.";

export const ONE_HOUR_CACHE_WINDOW_MS = 60 * 60 * 1000;
export const FIVE_MINUTE_CACHE_WINDOW_MS = 5 * 60 * 1000;

export const ONE_HOUR_CACHE_WARM_INTERVAL_MS = 58 * 60 * 1000;
export const FIVE_MINUTE_CACHE_WARM_INTERVAL_MS = 4.5 * 60 * 1000;

export const ONE_HOUR_CACHE_WARM_MAX_PINGS = 12;
export const FIVE_MINUTE_CACHE_WARM_MAX_PINGS = 10;

export interface PromptCacheWindows {
  cacheWindowMs: number;
  warmIntervalMs: number;
  maxConsecutivePings: number;
}

const PROMPT_CACHE_WINDOWS: Record<"5m" | "1h", PromptCacheWindows> = {
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
 * Claude Code then picks 1h or 5m from auth, overage and gateway routing, none of which
 * Paseo can observe, so warm-up cannot know when the cache expires.
 */
export function resolvePromptCacheWindows(promptCacheTtl: unknown): PromptCacheWindows | null {
  return promptCacheTtl === "5m" || promptCacheTtl === "1h"
    ? PROMPT_CACHE_WINDOWS[promptCacheTtl]
    : null;
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
}

/** One main-thread Anthropic request, stamped when its `message_start` arrived. */
export interface PromptCacheRequestSample extends PromptCacheRequestTokens {
  at: string;
  turnId: string | null;
  isWarmPing: boolean;
}

export interface AgentPromptCacheState {
  lastRequest: PromptCacheRequestSample;
  /** First request of the latest turn: the one that answers "did my prompt hit the cache". */
  turnFirstRequest: PromptCacheRequestSample;
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
