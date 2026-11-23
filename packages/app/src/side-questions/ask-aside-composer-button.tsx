import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { MessageCircleQuestionMark } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useSideQuestionActions } from "@/side-questions/actions-context";

const ThemedAsk = withUnistyles(MessageCircleQuestionMark);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** The composer's trailing control that opens an empty side question at the latest point. */
export const AskAsideComposerButton = memo(function AskAsideComposerButton() {
  const { t } = useTranslation();
  const actions = useSideQuestionActions();
  const open = actions?.open;
  const handlePress = useCallback(() => void open?.(), [open]);
  if (!open) return null;
  return (
    <View style={styles.slot}>
      <ToolbarButton
        label={t("sideQuestion.askAside")}
        onPress={handlePress}
        compact
        testID="composer-ask-aside"
      >
        <ThemedAsk size={ICON_SIZE.md} uniProps={mutedMapping} />
      </ToolbarButton>
    </View>
  );
});

const styles = StyleSheet.create(() => ({
  slot: { alignItems: "center", justifyContent: "center" },
}));
