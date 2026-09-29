import type { AgentSelectOption } from "../../agent-sdk-types.js";
import type { GatewayCodexModelRow } from "../../gateway/models.js";
import {
  CLAUDE_EFFORT_LABELS,
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_ULTRACODE_THINKING_OPTION_ID,
} from "./model-manifest.js";

/**
 * Capability names Claude Code accepts in `*_SUPPORTED_CAPABILITIES`. They are the
 * same tokens its baked-in model catalog carries, so declaring one here overrides
 * the permissive default that otherwise assumes full effort support for an
 * unrecognized model id.
 */
export const CLAUDE_EFFORT_CAPABILITY = "effort";
export const CLAUDE_XHIGH_EFFORT_CAPABILITY = "xhigh_effort";
export const CLAUDE_MAX_EFFORT_CAPABILITY = "max_effort";

/**
 * A gateway model's advertised effort ceiling, keyed by decoded model id.
 *
 * `low`/`medium`/`high` are always present: Claude Code has no capability to turn
 * effort off entirely, and the values the model actually honors are a server-side
 * decision. Only the two levels Claude Code gates per model are tracked here.
 */
export interface CliproxyEffortProfile {
  maxEffort: boolean;
  xhighEffort: boolean;
  /** Display name the gateway advertises, used for Claude Code's model label. */
  label?: string;
}

/**
 * Index the gateway's Codex-shape catalog by the id Claude Code will send.
 *
 * Codex rows are bare slugs; the Anthropic `/v1/models` rows Paseo launches with
 * are the decoded ids, so the two line up for every non-`claude-` model CPA
 * rewrites. Ids the catalog does not list are absent, not empty — the caller
 * decides how to treat "unknown", which is different from "known to lack max".
 */
export function indexCliproxyEffortProfiles(
  rows: readonly GatewayCodexModelRow[],
): Map<string, CliproxyEffortProfile> {
  const byId = new Map<string, CliproxyEffortProfile>();
  for (const row of rows) {
    const efforts = new Set(row.supportedReasoningEfforts);
    byId.set(row.slug, {
      maxEffort: efforts.has("max"),
      xhighEffort: efforts.has("xhigh"),
      // Codex names read "GPT 5.5"; the Anthropic row carries the display name the
      // gateway uses, so fall back to the slug rather than inventing a label.
      ...(row.displayName.trim() ? { label: row.displayName.trim() } : {}),
    });
  }
  return byId;
}

/**
 * Build the effort options a gateway model should expose.
 *
 * A slug the catalog does not list keeps the full custom-model set: the gateway
 * is the authority and an older or non-Codex-shaped build reports nothing. The
 * only change is to not offer a level the gateway has told us this model lacks.
 */
export function buildCliproxyThinkingOptions(
  profile: CliproxyEffortProfile | undefined,
): AgentSelectOption[] {
  const effortLevels = CLAUDE_EFFORT_LEVELS.filter((level) => {
    if (level === "xhigh") return profile?.xhighEffort ?? true;
    if (level === "max") return profile?.maxEffort ?? true;
    return true;
  });

  const options: AgentSelectOption[] = effortLevels.map((id) => ({
    id,
    label: CLAUDE_EFFORT_LABELS[id],
  }));
  // Ultra Code is xhigh plus workflow orchestration. Without xhigh it cannot run.
  if (profile?.xhighEffort !== false) {
    options.push({ id: CLAUDE_ULTRACODE_THINKING_OPTION_ID, label: "Ultra Code" });
  }
  return options;
}

/**
 * Claude Code capability list for a gateway model, used to tell the CLI what the
 * model actually supports instead of letting it assume the full vocabulary.
 *
 * `effort` stays on because a profile only ever gates the two top rungs; dropping
 * it would remove the `/effort` command entirely rather than cap a level.
 */
export function buildCliproxyCapabilityList(profile: CliproxyEffortProfile | undefined): string[] {
  return [
    CLAUDE_EFFORT_CAPABILITY,
    ...(profile?.xhighEffort === false ? [] : [CLAUDE_XHIGH_EFFORT_CAPABILITY]),
    ...(profile?.maxEffort === false ? [] : [CLAUDE_MAX_EFFORT_CAPABILITY]),
  ];
}
