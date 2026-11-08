import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { DropdownMenuSubTrigger, type MenuPageDefinition } from "@/components/ui/dropdown-menu";
import { AgentChatDisplayOptions, useChatDisplayName } from "./options";
import {
  useAgentChatDisplay,
  useAgentMessagesDisplay,
  useChooseAgentMessagesDisplay,
  useSetAgentChatDisplay,
} from "./use-agent-chat-display";

const PAGE_ID = "agent-chat-display";

export interface AgentChatDisplayMenuPage {
  /** The root row, `Chat display  <mode> ›`. Null when the visible tab is not an agent. */
  trigger: ReactElement | null;
  pages: MenuPageDefinition[];
}

/**
 * The compact menu's chat display choice for the agent on screen: a root row whose value is the
 * mode the chat renders, dotted while the agent has its own choice, and a page with the options.
 *
 * Call it from the component that owns the menu: the page renders on the far side of the sheet's
 * portal, so it gets its values and callback as props instead of reading context there.
 */
export function useAgentChatDisplayMenuPage(
  serverId: string,
  agentId: string | null,
): AgentChatDisplayMenuPage {
  const { t } = useTranslation();
  const display = useAgentChatDisplay(serverId, agentId);
  const setOverride = useSetAgentChatDisplay(serverId, agentId ?? "");
  const agentMessages = useAgentMessagesDisplay(serverId, agentId);
  const chooseAgentMessages = useChooseAgentMessagesDisplay(serverId, agentId ?? "");
  const displayName = useChatDisplayName();
  const value = displayName(display.effective);
  const hasOverride = display.override !== null;

  const trigger = useMemo(
    () =>
      agentId === null ? null : (
        <DropdownMenuSubTrigger
          id={PAGE_ID}
          value={value}
          indicator={hasOverride}
          testID="agent-chat-display-row"
        >
          {t("agentChatDisplay.rowLabel")}
        </DropdownMenuSubTrigger>
      ),
    [agentId, hasOverride, t, value],
  );

  const pages = useMemo<MenuPageDefinition[]>(
    () =>
      agentId === null
        ? []
        : [
            {
              id: PAGE_ID,
              title: t("agentChatDisplay.rowLabel"),
              content: (
                <AgentChatDisplayOptions
                  display={display}
                  onSelect={setOverride}
                  agentMessages={agentMessages}
                  onChooseAgentMessages={chooseAgentMessages}
                />
              ),
            },
          ],
    [agentId, chooseAgentMessages, display, agentMessages, setOverride, t],
  );

  return { trigger, pages };
}
