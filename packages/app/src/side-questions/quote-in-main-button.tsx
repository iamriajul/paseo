import { memo } from "react";
import { useTranslation } from "react-i18next";
import { CornerUpLeft } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedReturn = withUnistyles(CornerUpLeft);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** Brings a side question's answer back to the main chat as a quote. Nothing reaches it otherwise. */
export const QuoteInMainChatButton = memo(function QuoteInMainChatButton({
  onPress,
}: {
  onPress: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ToolbarButton
      label={t("quotes.quoteInMainChat")}
      onPress={onPress}
      compact
      testID="turn-quote-in-main-chat"
    >
      <ThemedReturn size={ICON_SIZE.sm} uniProps={mutedMapping} />
    </ToolbarButton>
  );
});
