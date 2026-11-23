import { memo } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import { minutesAgo, type SideQuestionCostLine } from "@/side-questions/model";

/** What the question under the composer will do to the prompt cache, before it is sent. */
export const SideQuestionCost = memo(function SideQuestionCost({
  line,
}: {
  line: SideQuestionCostLine;
}) {
  const { t } = useTranslation();
  if (line.kind === "none") return null;
  let text: string;
  if (line.kind === "warm") {
    text = t("sideQuestion.cacheWarm", { tokens: formatTokenCount(line.tokens) });
  } else if (line.kind === "expired") {
    text = t("sideQuestion.cacheExpired", {
      minutes: minutesAgo(line.expiredAgoMs),
      tokens: formatTokenCount(line.tokens),
    });
  } else {
    text = t("sideQuestion.earlierExpired", { tokens: formatTokenCount(line.tokens) });
  }
  return (
    <Text
      style={line.confirm ? styles.warning : styles.muted}
      testID="side-question-cost-line"
      accessibilityLiveRegion="polite"
    >
      {text}
    </Text>
  );
});

const styles = StyleSheet.create((theme) => ({
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  warning: { color: theme.colors.palette.amber[500], fontSize: theme.fontSize.sm },
}));
