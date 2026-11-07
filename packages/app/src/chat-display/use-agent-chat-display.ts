import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSettings, type ChatDisplay } from "@/hooks/use-settings";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useToast } from "@/contexts/toast-api-context";
import { toErrorMessage } from "@/utils/error-messages";
import {
  AGENT_CHAT_DISPLAY_LABEL,
  agentChatDisplayLabelPatch,
  resolveAgentChatDisplay,
  type AgentChatDisplay,
} from "./agent-override";

/**
 * The chat display for one agent: its own choice, else the Settings value. A chat with no host or
 * no Paseo agent behind it (a provider subagent) follows Settings.
 */
export function useAgentChatDisplay(
  serverId: string | null | undefined,
  agentId: string | null | undefined,
): AgentChatDisplay {
  const global = useSettings((settings) => settings.chatDisplay);
  // Select the one label value, so other agent updates don't re-render the chat.
  const labelValue = useSessionStore((state) => {
    if (!serverId || !agentId) return undefined;
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return agent?.labels[AGENT_CHAT_DISPLAY_LABEL];
  });
  return useMemo(
    () =>
      resolveAgentChatDisplay({
        global,
        labels: labelValue === undefined ? null : { [AGENT_CHAT_DISPLAY_LABEL]: labelValue },
      }),
    [global, labelValue],
  );
}

/** Writes the agent's own choice to the host; null goes back to following Settings. */
export function useSetAgentChatDisplay(
  serverId: string,
  agentId: string,
): (override: ChatDisplay | null) => void {
  const client = useHostRuntimeClient(serverId);
  const toast = useToast();
  const { t } = useTranslation();
  return useCallback(
    (override: ChatDisplay | null) => {
      if (!client) {
        toast.error(t("agentChatDisplay.errors.disconnected"));
        return;
      }
      client
        .updateAgent(agentId, { labels: agentChatDisplayLabelPatch(override) })
        .catch((error: unknown) => {
          toast.error(toErrorMessage(error) || t("agentChatDisplay.errors.saveFailed"));
        });
    },
    [agentId, client, t, toast],
  );
}
