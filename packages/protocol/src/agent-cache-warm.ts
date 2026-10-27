export const DEFAULT_CACHE_WARM_PING_PROMPT =
  "AFK for a bit, keeping you alive. Reply with 'ok' only.";

export const CACHE_WARM_QUESTION_PAUSE_MESSAGE =
  "The user is temporarily away (AFK). This question was automatically paused to preserve the prompt cache. Stand by and do not perform any other actions. When the user returns and sends a message:\n" +
  "- If the user provides the answer to the question directly, proceed using their answer.\n" +
  "- Otherwise (e.g. they say 'I am back', 'continue', 'ready', etc.), immediately call AskUserQuestion again with the exact question and options so they can answer.";

export const DEFAULT_CACHE_WARM_WINDOW_MS = 60 * 60 * 1000;
export const FIVE_MINUTE_CACHE_WARM_WINDOW_MS = 5 * 60 * 1000;

export const DEFAULT_CACHE_WARM_INTERVAL_MS = 58 * 60 * 1000;
export const SUBAGENT_CACHE_WARM_INTERVAL_MS = 4 * 60 * 1000;

export const DEFAULT_CACHE_WARM_MAX_PINGS = 12;
export const SUBAGENT_CACHE_WARM_MAX_PINGS = 10;

export function isFiveMinuteCacheWindow(input: {
  isSubagent: boolean;
  promptCacheTtl?: unknown;
}): boolean {
  return input.promptCacheTtl === "5m" || (input.isSubagent && input.promptCacheTtl !== "1h");
}

export function resolveDefaultCacheWarmEnabled(input: {
  isSubagent: boolean;
  promptCacheTtl?: unknown;
}): boolean {
  return isFiveMinuteCacheWindow(input);
}

export function resolvePromptCacheWindows(input: {
  isSubagent: boolean;
  promptCacheTtl?: unknown;
}): {
  cacheWindowMs: number;
  warmIntervalMs: number;
  maxConsecutivePings: number;
} {
  const isFiveMinuteWindow = isFiveMinuteCacheWindow(input);
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
