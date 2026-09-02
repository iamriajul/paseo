import type { ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";

// Shown while the tab is on a URL the daemon does not proxy. Not dismissible:
// it describes a condition that holds for as long as the tab stays there, and
// it removes itself when navigation reaches a proxied URL.
export function WebBrowserNotice(): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.notice}>
      <Text style={styles.text} role="status">
        {t("workspace.browser.iframeNotice")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  notice: {
    width: "100%",
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: theme.colors.muted,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  text: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
