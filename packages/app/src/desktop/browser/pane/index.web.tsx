import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { useBrowserStore } from "@/desktop/browser/store";
import { useBrowserPreviewTemplate } from "@/desktop/browser/workspace-browser-preview";
import { getUnsupportedIframeProtocol, resolveWebBrowserSrc } from "./web-preview-url";

interface BrowserPaneProps {
  browserId: string;
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  isInteractive?: boolean;
  isWorkspaceFocused?: boolean;
  onFocusPane?: () => void;
  onOpenUrlInBrowserTab?: (url: string) => void;
  chrome?: "visible" | "hidden";
}

const IFRAME_STYLE = {
  flex: 1,
  border: "none",
  width: "100%",
  height: "100%",
} as const;

export function BrowserPane({ browserId, serverId }: BrowserPaneProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const browser = useBrowserStore((state) => state.browsersById[browserId] ?? null);
  const template = useBrowserPreviewTemplate(serverId);
  const url = browser?.url ?? "https://example.com";
  const resolved = useMemo(() => resolveWebBrowserSrc({ url, template }), [url, template]);
  const titleStyle = useMemo(
    () => [styles.title, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const subtitleStyle = useMemo(
    () => [styles.subtitle, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );

  if (resolved.kind === "preview" || resolved.kind === "direct") {
    const unsupportedProtocol =
      resolved.kind === "direct" ? getUnsupportedIframeProtocol(resolved.src) : null;
    if (unsupportedProtocol) {
      return (
        <View style={styles.container}>
          <Text style={titleStyle}>
            {t("workspace.browser.errors.unsupportedProtocol", { protocol: unsupportedProtocol })}
          </Text>
        </View>
      );
    }
    if (!isWeb) {
      return null;
    }
    return (
      // Previews the user's own dev server (or an arbitrary site) like a real browser tab;
      // the daemon already strips X-Frame-Options/CSP so it runs unrestricted, and a sandbox
      // would break the scripts, forms, and popups a real page needs. Cross-origin isolation
      // already separates it from the Paseo origin.
      // oxlint-disable-next-line react/iframe-missing-sandbox
      <iframe
        src={resolved.src}
        style={IFRAME_STYLE}
        title={t("workspace.tabs.fallback.browser")}
      />
    );
  }

  if (resolved.kind === "rejected") {
    return (
      <View style={styles.container}>
        <Text style={titleStyle}>{t("workspace.browser.unspecifiedAddress.title")}</Text>
        <Text style={subtitleStyle}>
          {t("workspace.browser.unspecifiedAddress.subtitle", { address: url })}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={titleStyle}>{t("workspace.browser.previewNotConfigured.title")}</Text>
      <Text style={subtitleStyle}>{t("workspace.browser.previewNotConfigured.subtitle")}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 16,
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: "600",
  },
  subtitle: {
    fontSize: theme.fontSize.sm,
  },
}));
