import { memo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { describeServedBy, type ServedByLine } from "./served-by";

/**
 * The CLIProxyAPI account line above a user prompt: the account that answered it, and the switch
 * that brought the session there. "cache lost" takes the miss colour, since that is the turn that
 * paid to write the whole context again.
 */
export const ServedByAccountLine = memo(function ServedByAccountLine({
  line,
}: {
  line: ServedByLine;
}) {
  const text = describeServedBy({ ...line, cacheLost: false });
  return (
    <View style={styles.container} testID="served-by-account-line">
      <Text style={styles.text} numberOfLines={2}>
        {text}
        {line.cacheLost ? (
          <>
            <Text style={styles.text}>{" · "}</Text>
            <Text style={styles.cacheLost}>cache lost</Text>
          </>
        ) : null}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  // The stream row spaces the prompt from the turn above, so the line only needs its own gap to
  // the prompt; a negative margin here overlapped the prompt whenever the line wrapped.
  container: {
    alignItems: "flex-end",
    marginBottom: theme.spacing[1],
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
    textAlign: "right",
  },
  cacheLost: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
}));
