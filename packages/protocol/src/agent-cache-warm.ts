export const DEFAULT_CACHE_WARM_PING_PROMPT =
  "AFK for a bit, keeping you alive. Reply with 'ok' only.";

export const DEFAULT_CACHE_WARM_WINDOW_MS = 60 * 60 * 1000;
export const FIVE_MINUTE_CACHE_WARM_WINDOW_MS = 5 * 60 * 1000;

export const DEFAULT_CACHE_WARM_INTERVAL_MS = 58 * 60 * 1000;
export const SUBAGENT_CACHE_WARM_INTERVAL_MS = 4 * 60 * 1000;

export const DEFAULT_CACHE_WARM_MAX_PINGS = 12;
export const SUBAGENT_CACHE_WARM_MAX_PINGS = 10;

export function resolvePromptCacheWindows(input: {
  isSubagent: boolean;
  promptCacheTtl?: unknown;
}): {
  cacheWindowMs: number;
  warmIntervalMs: number;
  maxConsecutivePings: number;
} {
  const isFiveMinuteWindow =
    input.promptCacheTtl === "5m" || (input.isSubagent && input.promptCacheTtl !== "1h");
  return {
    cacheWindowMs: isFiveMinuteWindow
      ? FIVE_MINUTE_CACHE_WARM_WINDOW_MS
      : DEFAULT_CACHE_WARM_WINDOW_MS,
    warmIntervalMs: isFiveMinuteWindow
      ? SUBAGENT_CACHE_WARM_INTERVAL_MS
      : DEFAULT_CACHE_WARM_INTERVAL_MS,
    maxConsecutivePings: isFiveMinuteWindow
      ? SUBAGENT_CACHE_WARM_MAX_PINGS
      : DEFAULT_CACHE_WARM_MAX_PINGS,
  };
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
