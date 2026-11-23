import type { PromptCacheRequestTokens } from "@getpaseo/protocol/agent-cache-warm";

interface CodexRequestUsage {
  inputTokens?: unknown;
  cachedInputTokens?: unknown;
  cacheWriteInputTokens?: unknown;
  totalTokens?: unknown;
}

function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The cache split of the model request a `thread/tokenUsage/updated` reports, or null when it
 * reports no new request. `last` is that one request; `total` grows with every request, so an
 * update whose total did not grow (a resend, a rate-limit refresh) is not a request.
 *
 * OpenAI's `input_tokens` includes the cached reads. Codex reports cache writes
 * (`cacheWriteInputTokens`, Codex 0.167+) only for a provider that bills them; for OpenAI it is 0 or
 * absent, and since OpenAI caches every prompt on its own, the input a request did not read is
 * taken as written (`writeInferred`).
 */
export function readCodexRequestCache(
  tokenUsage: unknown,
  previousTotalTokens: number | null,
): { tokens: PromptCacheRequestTokens; totalTokens: number } | null {
  if (!tokenUsage || typeof tokenUsage !== "object") return null;
  const { last, total } = tokenUsage as { last?: CodexRequestUsage; total?: CodexRequestUsage };
  const totalTokens = readCount(total?.totalTokens);
  const inputTokens = readCount(last?.inputTokens);
  if (totalTokens === null || inputTokens === null || inputTokens === 0) return null;
  if (previousTotalTokens !== null && totalTokens <= previousTotalTokens) return null;
  const readTokens = Math.min(readCount(last?.cachedInputTokens) ?? 0, inputTokens);
  const reportedWrite = Math.min(
    readCount(last?.cacheWriteInputTokens) ?? 0,
    inputTokens - readTokens,
  );
  if (reportedWrite > 0) {
    return {
      tokens: {
        readTokens,
        writeTokens: reportedWrite,
        uncachedTokens: inputTokens - readTokens - reportedWrite,
      },
      totalTokens,
    };
  }
  return {
    tokens: {
      readTokens,
      writeTokens: inputTokens - readTokens,
      uncachedTokens: 0,
      writeInferred: true,
    },
    totalTokens,
  };
}
