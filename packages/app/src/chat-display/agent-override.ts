import type { ChatDisplay } from "@/hooks/use-settings";

/**
 * An agent's own chat display, kept as an agent label so the daemon stores it with the agent and
 * every connected device gets it through the agent's own updates. See docs/fork-decisions.md
 * `agent-chat-display-override`.
 */
export const AGENT_CHAT_DISPLAY_LABEL = "paseo.chat-display";

/**
 * The wire `update_agent` labels cannot delete a key, so following Settings is written as an
 * empty value. Any value that is not a display reads as following Settings too.
 */
export const FOLLOW_SETTINGS_LABEL_VALUE = "";

export const CHAT_DISPLAYS: readonly ChatDisplay[] = ["full", "collapseToolCalls", "collapseTurns"];

function isChatDisplay(value: unknown): value is ChatDisplay {
  return (CHAT_DISPLAYS as readonly unknown[]).includes(value);
}

/** The agent's own choice, or null when it follows Settings. */
export function readAgentChatDisplayOverride(
  labels: Readonly<Record<string, string>> | null | undefined,
): ChatDisplay | null {
  const value = labels?.[AGENT_CHAT_DISPLAY_LABEL];
  return isChatDisplay(value) ? value : null;
}

export function agentChatDisplayLabelPatch(override: ChatDisplay | null): Record<string, string> {
  return { [AGENT_CHAT_DISPLAY_LABEL]: override ?? FOLLOW_SETTINGS_LABEL_VALUE };
}

export interface AgentChatDisplay {
  /** What the chat renders. */
  effective: ChatDisplay;
  /** The agent's own choice; null follows Settings. */
  override: ChatDisplay | null;
  /** The Settings value, shown beside the follow-Settings choice. */
  global: ChatDisplay;
}

export function resolveAgentChatDisplay(input: {
  global: ChatDisplay;
  labels: Readonly<Record<string, string>> | null | undefined;
}): AgentChatDisplay {
  const override = readAgentChatDisplayOverride(input.labels);
  return { effective: override ?? input.global, override, global: input.global };
}
