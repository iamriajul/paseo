import type { AgentMessagesDisplay } from "@/hooks/use-settings";
import { FOLLOW_SETTINGS_LABEL_VALUE } from "./agent-override";

/**
 * An agent's own agent-messages display, kept as an agent label beside its chat display so every
 * connected device gets it. See docs/fork-decisions.md `agent-messages-collapse`.
 */
export const AGENT_MESSAGES_DISPLAY_LABEL = "paseo.agent-messages";

export const AGENT_MESSAGES_DISPLAYS: readonly AgentMessagesDisplay[] = ["collapsed", "expanded"];

function isAgentMessagesDisplay(value: unknown): value is AgentMessagesDisplay {
  return (AGENT_MESSAGES_DISPLAYS as readonly unknown[]).includes(value);
}

export interface AgentMessagesDisplayState {
  effective: AgentMessagesDisplay;
  /** The agent's own choice; null follows Settings. */
  override: AgentMessagesDisplay | null;
  global: AgentMessagesDisplay;
}

export function resolveAgentMessagesDisplay(input: {
  global: AgentMessagesDisplay;
  labelValue: string | undefined;
}): AgentMessagesDisplayState {
  const override = isAgentMessagesDisplay(input.labelValue) ? input.labelValue : null;
  return { effective: override ?? input.global, override, global: input.global };
}

/**
 * Choosing the Settings value follows Settings again, so an agent keeps its own choice only while
 * it differs.
 */
export function agentMessagesDisplayLabelPatch(input: {
  choice: AgentMessagesDisplay;
  global: AgentMessagesDisplay;
}): Record<string, string> {
  return {
    [AGENT_MESSAGES_DISPLAY_LABEL]:
      input.choice === input.global ? FOLLOW_SETTINGS_LABEL_VALUE : input.choice,
  };
}
