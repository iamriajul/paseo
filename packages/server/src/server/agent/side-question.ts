import {
  CACHE_AUTO_COMPACT_FEATURE_ID,
  CACHE_WARM_FEATURE_ID,
  promptCacheInputTokens,
  resolveEffectivePromptCacheWindows,
  type PromptCacheHistoryEntry,
  type PromptCacheTtl,
} from "@getpaseo/protocol/agent-cache-warm";
import { isSideQuestionAgent, SIDE_QUESTION_OF_LABEL } from "@getpaseo/protocol/agent-labels";
import type { SideQuestionCacheEstimate } from "@getpaseo/protocol/messages";
import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { resolveAgentPromptCacheExpiresAtMs } from "./prompt-cache-expiry.js";
import { CLAUDE_PROMPT_CACHE_TTL_FEATURE_ID } from "./providers/claude/feature-definitions.js";

/** A side question's process stops after this long without a request; a follow-up resumes it. */
export const SIDE_QUESTION_IDLE_STOP_MS = 5 * 60_000;

/** Where a side question forked, kept on the agent so the cost estimate can find the point again. */
export const SIDE_QUESTION_POINT_LABEL = "paseo.side-question-point";
export const SIDE_QUESTION_BOUNDARY_AT_LABEL = "paseo.side-question-boundary-at";

export { SIDE_QUESTION_OF_LABEL };

/**
 * The launch config of a side question: every option that shapes the request prefix is the
 * source's (model, thinking, system prompt, tool policy, cache window), so the fork reads the
 * source's prompt cache. What differs is what the session may do: default mode, no MCP servers,
 * no warm-up or compaction of its own, and the provider's read-only enforcement.
 */
export function buildSideQuestionConfig(input: {
  source: AgentSessionConfig;
  sourceCwd: string;
  /** The account that holds the source's cache; a fork of a fork keeps the root's. */
  sessionAffinityId: string;
}): AgentSessionConfig {
  const { source } = input;
  const { mcpServers: _mcpServers, ...rest } = source;
  return {
    ...rest,
    provider: "claude",
    cwd: input.sourceCwd,
    // Not the chat's title: the question's first line names it.
    title: null,
    modeId: "default",
    sideQuestion: true,
    mcpServers: {},
    featureValues: {
      ...source.featureValues,
      [CACHE_WARM_FEATURE_ID]: false,
      [CACHE_AUTO_COMPACT_FEATURE_ID]: false,
    },
    providerOptions: {
      ...source.providerOptions,
      sessionAffinityId: input.sessionAffinityId,
    },
  };
}

export interface SideQuestionCacheView {
  provider: string;
  config?: { model?: string | null; featureValues?: Record<string, unknown> | null } | null;
  runtimeInfo?: { model?: string | null } | null;
  lastResponseAt?: Date | string | null;
  promptCache?: {
    lastRequest: { at: string } & Parameters<typeof promptCacheInputTokens>[0];
    observedTtl?: PromptCacheTtl;
    history?: readonly PromptCacheHistoryEntry[];
  } | null;
}

/**
 * What the next question does to the prompt cache, from what the daemon already recorded.
 * A follow-up reads the side session's own entry. The first question reads the source's: at the
 * latest point that is the source's last request; at an earlier point it is the request that
 * ended the chosen turn, which lives one window after that turn and is not refreshed by later
 * turns (an Anthropic rule, not yet measured here).
 */
export function estimateSideQuestionCache(input: {
  nowMs: number;
  point: "latest" | "earlier";
  boundaryAtMs: number | null;
  source: SideQuestionCacheView | null;
  side: SideQuestionCacheView | null;
}): SideQuestionCacheEstimate {
  const own = input.side?.promptCache;
  if (own) {
    return judge({
      point: input.point,
      nowMs: input.nowMs,
      expiresAtMs: resolveAgentPromptCacheExpiresAtMs(input.side as SideQuestionCacheView),
      tokens: promptCacheInputTokens(own.lastRequest),
    });
  }
  const source = input.source;
  if (!source?.promptCache) return unknown(input.point);
  if (input.point === "latest") {
    return judge({
      point: "latest",
      nowMs: input.nowMs,
      expiresAtMs: resolveAgentPromptCacheExpiresAtMs(source),
      tokens: promptCacheInputTokens(source.promptCache.lastRequest),
    });
  }
  const entry =
    input.boundaryAtMs === null
      ? undefined
      : (source.promptCache.history ?? []).findLast(
          (candidate) => Date.parse(candidate.at) <= (input.boundaryAtMs as number),
        );
  if (!entry) return unknown("earlier");
  const windows = resolveEffectivePromptCacheWindows({
    observedTtl: entry.writeTtl ?? source.promptCache.observedTtl,
    promptCacheTtl: source.config?.featureValues?.[CLAUDE_PROMPT_CACHE_TTL_FEATURE_ID],
  });
  return judge({
    point: "earlier",
    nowMs: input.nowMs,
    expiresAtMs: windows ? Date.parse(entry.at) + windows.cacheWindowMs : null,
    tokens: promptCacheInputTokens(entry),
  });
}

function unknown(point: "latest" | "earlier"): SideQuestionCacheEstimate {
  return { point, state: "unknown", tokens: null, expiredAgoMs: null };
}

function judge(input: {
  point: "latest" | "earlier";
  nowMs: number;
  expiresAtMs: number | null;
  tokens: number;
}): SideQuestionCacheEstimate {
  if (input.expiresAtMs === null) return unknown(input.point);
  if (input.nowMs < input.expiresAtMs) {
    return { point: input.point, state: "warm", tokens: input.tokens, expiredAgoMs: null };
  }
  return {
    point: input.point,
    state: "expired",
    tokens: input.tokens,
    expiredAgoMs: input.nowMs - input.expiresAtMs,
  };
}

export function sideQuestionPointLabels(input: {
  point: "latest" | "earlier";
  boundaryAt: string | null;
}): Record<string, string> {
  return {
    [SIDE_QUESTION_POINT_LABEL]: input.point,
    ...(input.boundaryAt ? { [SIDE_QUESTION_BOUNDARY_AT_LABEL]: input.boundaryAt } : {}),
  };
}

/** The settings a side question locks: the mode, the model, thinking and features of its session. */
export function assertSideQuestionUnlocked(
  agent: { labels?: Record<string, string> | null },
  what: string,
): void {
  if (isSideQuestionAgent(agent)) {
    throw new Error(`Side questions are read-only; their ${what} is locked`);
  }
}

/** A reload with overrides is how a mode, model or tool change reaches a session; refuse it. */
export function assertSideQuestionOverridesAllowed(
  agent: { labels?: Record<string, string> | null },
  overrides: unknown,
): void {
  if (overrides) assertSideQuestionUnlocked(agent, "configuration");
}
