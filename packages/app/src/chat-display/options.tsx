import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { FoldVertical, ListCollapse, Settings2, TextAlignJustify } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import type { ChatDisplay } from "@/hooks/use-settings";
import type { Theme } from "@/styles/theme";
import { CHAT_DISPLAYS, type AgentChatDisplay } from "./agent-override";

const ThemedTextAlignJustify = withUnistyles(TextAlignJustify);
const ThemedListCollapse = withUnistyles(ListCollapse);
const ThemedFoldVertical = withUnistyles(FoldVertical);
const ThemedSettings2 = withUnistyles(Settings2);

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
}: {
  display: AgentChatDisplay;
  onSelect: (override: ChatDisplay | null) => void;
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
