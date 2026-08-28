import type {
  AgentFeature,
  AgentFeatureSelect,
  AgentFeatureToggle,
} from "../../agent-sdk-types.js";
import { claudeManifestModelSupportsFastMode } from "./model-manifest.js";

export const CLAUDE_FAST_MODE_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: "fast_mode",
  label: "Fast",
  description: "Lower latency Opus responses at higher token cost",
  tooltip: "Toggle fast mode",
  icon: "zap",
};

export const CLAUDE_PROMPT_CACHE_TTL_FEATURE_ID = "prompt_cache_ttl";
export const CLAUDE_PROMPT_CACHE_TTL_VALUES = ["default", "5m", "1h"] as const;

export const CLAUDE_PROMPT_CACHE_TTL_FEATURE: Omit<AgentFeatureSelect, "value"> = {
  type: "select",
  id: CLAUDE_PROMPT_CACHE_TTL_FEATURE_ID,
  label: "Prompt cache TTL",
  description: "Cache write duration for this conversation and its subagents",
  tooltip: "Shorter TTLs cost less on cache writes; longer TTLs keep the cache warm",
  icon: "clock",
  options: [
    {
      id: "default",
      label: "Automatic",
      description: "Claude Code chooses based on auth and usage limits",
    },
    { id: "5m", label: "5 minutes", description: "Cheapest writes; cache cools in 5 minutes" },
    { id: "1h", label: "1 hour", description: "Premium writes; cache stays warm longer" },
  ],
};

export function claudeModelSupportsFastMode(modelId: string | null | undefined): boolean {
  return claudeManifestModelSupportsFastMode(modelId);
}

export function buildClaudeFeatures(input: {
  modelId: string | null | undefined;
  fastModeEnabled: boolean;
  promptCacheTtl?: unknown;
}): AgentFeature[] {
  const features: AgentFeature[] = [];

  if (claudeModelSupportsFastMode(input.modelId)) {
    features.push({
      ...CLAUDE_FAST_MODE_FEATURE,
      value: input.fastModeEnabled,
    });
  }

  // The TTL select only appears once a value is stamped on the config, which
  // happens for orchestrator-spawned Claude agents. User-opened agents keep
  // Claude Code's automatic behavior and no visible control.
  const promptCacheTtl = resolveClaudePromptCacheTtl(input.promptCacheTtl);
  if (promptCacheTtl !== undefined) {
    features.push({
      ...CLAUDE_PROMPT_CACHE_TTL_FEATURE,
      value: promptCacheTtl,
    });
  }

  return features;
}

/**
 * Validate a stored prompt_cache_ttl feature value. Returns undefined for
 * missing or unknown values so callers can hide the control or fall back to
 * Claude Code's automatic TTL.
 */
export function resolveClaudePromptCacheTtl(value: unknown): string | undefined {
  return typeof value === "string" &&
    (CLAUDE_PROMPT_CACHE_TTL_VALUES as readonly string[]).includes(value)
    ? value
    : undefined;
}
