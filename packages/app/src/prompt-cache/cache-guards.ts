import { isClaudeModel } from "@getpaseo/protocol/agent-cache-warm";
import { liveCacheRemainingMs } from "./cache-window-change";
import type { PromptCacheView } from "./use-prompt-cache";

/** The cheap model a cold agent compacts on before its own model writes the summary. */
export const COLD_SEND_COMPACT_MODEL_ID = "claude-haiku-5-5";
export const COLD_SEND_COMPACT_MODEL_LABEL = "Haiku 5.5";
export const COLD_SEND_COMPACT_THINKING_OPTION_ID = "max";

interface GuardedAgent {
  provider: string;
  modelId: string | null | undefined;
}

function isFirstPartyClaude(agent: GuardedAgent): boolean {
  return agent.provider === "claude" && isClaudeModel(agent.modelId);
}

function isHaikuModel(modelId: string | null | undefined): boolean {
  return (modelId ?? "").toLowerCase().includes("haiku");
}

/**
 * Time left on the live cache a model switch would drop, or null when the switch needs no
 * confirmation. The cache belongs to one model, so switching writes the whole context again on
 * the new one. It only asks while warm-up is keeping that cache alive.
 */
export function resolveModelSwitchGuard(input: {
  agent: GuardedAgent;
  nextModelId: string;
  view: Pick<PromptCacheView, "status" | "warmup">;
}): number | null {
  if (!isFirstPartyClaude(input.agent) || input.nextModelId === input.agent.modelId) return null;
  if (!input.view.warmup?.enabled) return null;
  return liveCacheRemainingMs(input.view.status);
}

/**
 * Whether a message to this agent waits for confirmation: its cache has expired, so the message
 * writes the whole context again at its model's price. Haiku is already the cheap compaction
 * model, a slash command is not a prompt that needs the context, and right after a compaction
 * (the user's or the idle cap's) the message writes only the summary, so there is nothing to save.
 */
export function resolveColdSendGuard(input: {
  agent: GuardedAgent;
  text: string;
  view: Pick<PromptCacheView, "status" | "lastTurnCompacted">;
}): boolean {
  if (!isFirstPartyClaude(input.agent) || isHaikuModel(input.agent.modelId)) return false;
  if (input.text.trimStart().startsWith("/")) return false;
  if (input.view.lastTurnCompacted) return false;
  return input.view.status.kind === "expired";
}

const CLAUDE_FAMILIES = ["opus", "fable", "mythos", "sonnet", "haiku"] as const;

/** "Opus" for claude-opus-5-5: the dialogs name the model the user picked, not its id. */
export function formatClaudeModelFamily(modelId: string | null | undefined): string {
  const lower = (modelId ?? "").toLowerCase();
  const family = CLAUDE_FAMILIES.find((candidate) => lower.includes(candidate));
  return family ? family.charAt(0).toUpperCase() + family.slice(1) : "Claude";
}
