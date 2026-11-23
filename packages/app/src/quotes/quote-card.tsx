import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Quote, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import type { ComposerQuote } from "@/attachments/types";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedQuote = withUnistyles(Quote);
const ThemedX = withUnistyles(X);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export type QuoteCardQuote = Pick<ComposerQuote, "origin" | "text" | "partial" | "messageId">;

interface QuoteCardProps {
  quote: QuoteCardQuote;
  /** The composer's card has a remove button; the sent message's card does not. */
  onRemove?: () => void;
  /** Pressing the source line scrolls the chat to the quoted message. */
  onPressSource?: (messageId: string) => void;
  testID?: string;
}

const SOURCE_KEY = {
  assistant: "quotes.sourceAssistant",
  user: "quotes.sourceUser",
  side_question: "quotes.sourceSideQuestion",
} as const;

export function useQuoteSourceLabel(): (quote: QuoteCardQuote) => string {
  const { t } = useTranslation();
  return useCallback(
    (quote) => {
      const source = t(SOURCE_KEY[quote.origin]);
      return quote.partial ? `${source} · ${t("quotes.selection")}` : source;
    },
    [t],
  );
}

export const QuoteCard = memo(function QuoteCard({
  quote,
  onRemove,
  onPressSource,
  testID = "quote-card",
}: QuoteCardProps) {
  const { t } = useTranslation();
  const sourceLabel = useQuoteSourceLabel()(quote);
  const messageId = quote.messageId;
  const handlePressSource = useCallback(() => {
    if (messageId) onPressSource?.(messageId);
  }, [messageId, onPressSource]);
  const canJump = Boolean(onPressSource && messageId);

  const source = (
    <View style={styles.sourceRow}>
      <ThemedQuote size={ICON_SIZE.sm - 2} uniProps={mutedMapping} />
      <Text style={styles.source} numberOfLines={1}>
        {sourceLabel}
      </Text>
    </View>
  );

  return (
    <View style={styles.card} testID={testID}>
      <View style={styles.body}>
        {canJump ? (
          <PressHighlight
            onPress={handlePressSource}
            accessibilityRole="button"
            accessibilityLabel={t("quotes.jumpToSource")}
            testID={`${testID}-source`}
          >
            {source}
          </PressHighlight>
        ) : (
          source
        )}
        <Text style={styles.text} numberOfLines={2} ellipsizeMode="tail" testID={`${testID}-text`}>
          {quote.text}
        </Text>
      </View>
      {onRemove ? (
        <ToolbarButton
          label={t("quotes.remove")}
          onPress={onRemove}
          compact
          testID={`${testID}-remove`}
        >
          <ThemedX size={ICON_SIZE.sm} uniProps={mutedMapping} />
        </ToolbarButton>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  card: {
    flexDirection: "row",
    alignItems: "flex-start",
    alignSelf: "stretch",
    gap: theme.spacing[2],
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  sourceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  source: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
