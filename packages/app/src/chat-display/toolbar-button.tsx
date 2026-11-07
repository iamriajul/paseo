import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { AgentChatDisplayOptions, ChatDisplayIcon, useChatDisplayName } from "./options";
import { useAgentChatDisplay, useSetAgentChatDisplay } from "./use-agent-chat-display";

const TOOLBAR_ICON_SIZE = 14;

/**
 * The pane toolbar's chat display menu for the agent the pane is showing. Its glyph is the mode
 * the chat renders, its tooltip names it and where it comes from, and it reads as pressed while the
 * agent has its own choice.
 */
export function AgentChatDisplayToolbarButton({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement {
  const { t } = useTranslation();
  const display = useAgentChatDisplay(serverId, agentId);
  const setOverride = useSetAgentChatDisplay(serverId, agentId);
  const displayName = useChatDisplayName();
  const label = t(
    display.override === null
      ? "agentChatDisplay.tooltipFollowingSettings"
      : "agentChatDisplay.tooltipOverridden",
    { mode: displayName(display.effective) },
  );
  return (
    <DropdownMenu>
      <ToolbarButton
        kind="menu"
        label={label}
        selected={display.override !== null}
        testID="agent-chat-display-toolbar-button"
      >
        <ChatDisplayIcon display={display.effective} size={TOOLBAR_ICON_SIZE} tone="extraMuted" />
      </ToolbarButton>
      <DropdownMenuContent
        side="bottom"
        align="end"
        offset={4}
        width={240}
        testID="agent-chat-display-menu"
      >
        <AgentChatDisplayOptions display={display} onSelect={setOverride} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
