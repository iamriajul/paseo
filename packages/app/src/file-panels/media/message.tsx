import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/** A centered note in place of the player: why it cannot play, or what it is waiting for. */
export function MediaMessage({
  message,
  tone = "muted",
  children,
}: {
  message: string;
  tone?: "muted" | "error";
  children?: ReactNode;
}) {
  return (
    <View style={styles.container} testID="media-file-message">
      <Text style={tone === "error" ? styles.error : styles.muted}>{message}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
