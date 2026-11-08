import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  FoldVertical,
  ListCollapse,
  Settings2,
  TextAlignJustify,
} from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { AgentMessagesDisplay, ChatDisplay } from "@/hooks/use-settings";
import type { AgentMessagesDisplayState } from "./agent-messages-override";
import type { Theme } from "@/styles/theme";
import { CHAT_DISPLAYS, type AgentChatDisplay } from "./agent-override";

const ThemedTextAlignJustify = withUnistyles(TextAlignJustify);
const ThemedListCollapse = withUnistyles(ListCollapse);
const ThemedFoldVertical = withUnistyles(FoldVertical);
const ThemedSettings2 = withUnistyles(Settings2);
const ThemedChevronsDownUp = withUnistyles(ChevronsDownUp);
const ThemedChevronsUpDown = withUnistyles(ChevronsUpDown);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const extraMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

const ROW_ICON_SIZE = 16;

export function ChatDisplayIcon({
  display,
  size,
  tone = "muted",
}: {
  display: ChatDisplay;
  size: number;
  tone?: "muted" | "extraMuted";
}): ReactElement {
  const uniProps = tone === "muted" ? mutedColorMapping : extraMutedColorMapping;
  switch (display) {
    case "full":
      return <ThemedTextAlignJustify size={size} uniProps={uniProps} />;
    case "collapseToolCalls":
      return <ThemedListCollapse size={size} uniProps={uniProps} />;
    case "collapseTurns":
      return <ThemedFoldVertical size={size} uniProps={uniProps} />;
  }
}

/** The name the Settings select uses, so the two surfaces call each mode the same thing. */
export function useChatDisplayName(): (display: ChatDisplay) => string {
  const { t } = useTranslation();
  return (display) => t(`settings.general.chatDisplay.options.${display}`);
}

const FOLLOW_SETTINGS_ICON = <ThemedSettings2 size={ROW_ICON_SIZE} uniProps={mutedColorMapping} />;

/**
 * The choice itself, shared by the desktop toolbar menu and the compact menu's page: follow
 * Settings first, so the way back is the first thing you read, then the three modes.
 */
export function AgentChatDisplayOptions({
  display,
  onSelect,
  agentMessages,
  onChooseAgentMessages,
}: {
  display: AgentChatDisplay;
  onSelect: (override: ChatDisplay | null) => void;
  agentMessages: AgentMessagesDisplayState;
  onChooseAgentMessages: (choice: AgentMessagesDisplay) => void;
}): ReactElement {
  const { t } = useTranslation();
  const displayName = useChatDisplayName();
  const followSettings = useCallback(() => onSelect(null), [onSelect]);
  return (
    <>
      <DropdownMenuItem
        testID="agent-chat-display-follow-settings"
        leading={FOLLOW_SETTINGS_ICON}
        description={displayName(display.global)}
        selected={display.override === null}
        onSelect={followSettings}
      >
        {t("agentChatDisplay.followSettings")}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {CHAT_DISPLAYS.map((mode) => (
        <ChatDisplayOptionRow
          key={mode}
          mode={mode}
          label={displayName(mode)}
          selected={display.override === mode}
          onSelect={onSelect}
        />
      ))}
      <DropdownMenuSeparator />
      <AgentMessagesOptions display={agentMessages} onChoose={onChooseAgentMessages} />
    </>
  );
}

const COLLAPSE_ALL_ICON = (
  <ThemedChevronsDownUp size={ROW_ICON_SIZE} uniProps={mutedColorMapping} />
);
const EXPAND_ALL_ICON = <ThemedChevronsUpDown size={ROW_ICON_SIZE} uniProps={mutedColorMapping} />;

/**
 * Collapse all and Expand all for messages from other agents. Each saves the agent's display and
 * resets the rows opened one by one, so the checked row is the display new messages arrive in.
 */
function AgentMessagesOptions({
  display,
  onChoose,
}: {
  display: AgentMessagesDisplayState;
  onChoose: (choice: AgentMessagesDisplay) => void;
}): ReactElement {
  const { t } = useTranslation();
  const collapseAll = useCallback(() => onChoose("collapsed"), [onChoose]);
  const expandAll = useCallback(() => onChoose("expanded"), [onChoose]);
  return (
    <>
      <DropdownMenuLabel>{t("agentMessages.sectionLabel")}</DropdownMenuLabel>
      <DropdownMenuItem
        testID="agent-messages-collapse-all"
        leading={COLLAPSE_ALL_ICON}
        selected={display.effective === "collapsed"}
        onSelect={collapseAll}
      >
        {t("agentMessages.collapseAll")}
      </DropdownMenuItem>
      <DropdownMenuItem
        testID="agent-messages-expand-all"
        leading={EXPAND_ALL_ICON}
        selected={display.effective === "expanded"}
        onSelect={expandAll}
      >
        {t("agentMessages.expandAll")}
      </DropdownMenuItem>
    </>
  );
}

function ChatDisplayOptionRow({
  mode,
  label,
  selected,
  onSelect,
}: {
  mode: ChatDisplay;
  label: string;
  selected: boolean;
  onSelect: (override: ChatDisplay | null) => void;
}): ReactElement {
  const leading = useMemo(() => <ChatDisplayIcon display={mode} size={ROW_ICON_SIZE} />, [mode]);
  const choose = useCallback(() => onSelect(mode), [mode, onSelect]);
  return (
    <DropdownMenuItem
      testID={`agent-chat-display-${mode}`}
      leading={leading}
      selected={selected}
      onSelect={choose}
    >
      {label}
    </DropdownMenuItem>
  );
}
