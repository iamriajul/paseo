import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Quote } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedQuote = withUnistyles(Quote);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface TurnQuoteButtonProps {
  onPress: () => void;
  testID?: string;
}

/** The footer and message-action button that quotes a whole message into the composer. */
export const TurnQuoteButton = memo(function TurnQuoteButton({
  onPress,
  testID = "turn-quote-button",
}: TurnQuoteButtonProps) {
  const { t } = useTranslation();
  return (
    <ToolbarButton label={t("quotes.quoteMessage")} onPress={onPress} compact testID={testID}>
      <ThemedQuote size={ICON_SIZE.sm} uniProps={mutedMapping} />
    </ToolbarButton>
  );
});
