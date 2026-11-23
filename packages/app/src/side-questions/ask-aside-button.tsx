import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { MessageCircleQuestionMark } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedAsk = withUnistyles(MessageCircleQuestionMark);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const icon = <ThemedAsk size={ICON_SIZE.sm} uniProps={mutedMapping} />;
const menuIcon = <ThemedAsk size={ICON_SIZE.sm} uniProps={foregroundMapping} />;

interface AskAsideButtonProps {
  /** The latest reply has one action; an earlier one chooses between the two forks. */
  isLatest: boolean;
  onAskLatest: () => void;
  onAskAboutReply: () => void;
  onAskFromPoint: () => void;
}

/**
 * The footer action that asks a side question. On the latest reply it opens an empty one. On an
 * earlier reply it offers **Ask about this reply**, the default, which forks at the latest point so
 * the whole prompt cache is read, and **Ask from this point**, for when the agent must not know
 * what came later.
 */
export const AskAsideButton = memo(function AskAsideButton({
  isLatest,
  onAskLatest,
  onAskAboutReply,
  onAskFromPoint,
}: AskAsideButtonProps) {
  const { t } = useTranslation();
  const askAbout = useCallback(() => onAskAboutReply(), [onAskAboutReply]);
  const askFrom = useCallback(() => onAskFromPoint(), [onAskFromPoint]);
  if (isLatest) {
    return (
      <ToolbarButton
        label={t("sideQuestion.askAside")}
        onPress={onAskLatest}
        compact
        testID="turn-ask-aside"
      >
        {icon}
      </ToolbarButton>
    );
  }
  return (
    <DropdownMenu>
      <ToolbarButton
        kind="menu"
        label={t("sideQuestion.askAside")}
        compact
        testID="turn-ask-aside-menu"
      >
        {icon}
      </ToolbarButton>
      <DropdownMenuContent
        align="start"
        minWidth={220}
        side="bottom"
        testID="turn-ask-aside-content"
      >
        <DropdownMenuItem leading={menuIcon} onSelect={askAbout} testID="turn-ask-aside-about">
          {t("sideQuestion.askAboutReply")}
        </DropdownMenuItem>
        <DropdownMenuItem leading={menuIcon} onSelect={askFrom} testID="turn-ask-aside-from">
          {t("sideQuestion.askFromPoint")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
