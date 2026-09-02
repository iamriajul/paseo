import type { ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";

// Shown while the frame is somewhere the injected bridge does not reach: a URL
// the daemon does not proxy, or a proxied page the frame has since navigated
// off. Not dismissible: it describes a condition that holds for as long as the
// frame stays there, and it removes itself when navigation reaches a page the
// bridge is in.
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
