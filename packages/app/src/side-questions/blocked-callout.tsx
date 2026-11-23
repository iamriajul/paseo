import { memo, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useAgentStreamTail } from "@/agent-stream/use-agent-stream-tail";
import { useContinueSideQuestion } from "@/side-questions/header";

/** What a blocked tool call fails with; the daemon's `SIDE_QUESTION_DENY_MESSAGE`. */
const BLOCKED_MARKER = "Side questions are read-only";

/**
 * Offered once a tool call was blocked: the question needed something a side question cannot do,
 * and a full session is the same conversation with the main chat's mode and tools.
 */
export const SideQuestionBlockedCallout = memo(function SideQuestionBlockedCallout({
  serverId,
  sideAgentId,
}: {
  serverId: string;
  sideAgentId: string;
}) {
  const { t } = useTranslation();
  const items = useAgentStreamTail(serverId, sideAgentId);
  const blocked = useMemo(
    () =>
      (items ?? []).some(
        (item) =>
          item.kind === "tool_call" &&
          item.payload.source === "agent" &&
          JSON.stringify(item.payload.data.error ?? "").includes(BLOCKED_MARKER),
      ),
    [items],
  );
  const handleContinue = useContinueSideQuestion({ serverId, sideAgentId });
  if (!blocked) return null;
  return (
    <View style={styles.callout} testID="side-question-blocked-callout">
      <Text style={styles.text}>{t("sideQuestion.needsFullSession")}</Text>
      <Button
        variant="outline"
        size="sm"
        onPress={handleContinue}
        testID="side-question-blocked-continue"
      >
        {t("sideQuestion.continueFull")}
      </Button>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  callout: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  text: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
