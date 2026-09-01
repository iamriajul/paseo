import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { normalizeWorkspaceBrowserUrl, useBrowserStore } from "@/desktop/browser/store";
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
  const updateBrowser = useBrowserStore((state) => state.updateBrowser);
  const template = useBrowserPreviewTemplate(serverId);
  const url = browser?.url ?? "https://example.com";
  const resolved = useMemo(() => resolveWebBrowserSrc({ url, template }), [url, template]);

  // The address bar shows the URL the user typed (e.g. localhost:5173) while the
  // iframe loads the resolved preview origin. Bumping `reloadKey` remounts the
  // iframe to reload it — a cross-origin frame can't be reloaded through the DOM.
  const urlInputRef = useRef<EditingTextInputHandle | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  const submit = useCallback(() => {
    const next = normalizeWorkspaceBrowserUrl(urlInputRef.current?.getText() ?? url);
    if (next === url) {
      reload();
    } else {
      updateBrowser(browserId, { url: next });
    }
  }, [url, reload, updateBrowser, browserId]);

  const titleStyle = useMemo(
    () => [styles.title, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const subtitleStyle = useMemo(
    () => [styles.subtitle, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );

  // No reachable preview origin for this host — nothing to navigate to, so no
  // address bar either.
  if (resolved.kind === "no-template") {
    return (
      <View style={styles.container}>
        <Text style={titleStyle}>{t("workspace.browser.previewNotConfigured.title")}</Text>
        <Text style={subtitleStyle}>{t("workspace.browser.previewNotConfigured.subtitle")}</Text>
      </View>
    );
  }

  const unsupportedProtocol =
    resolved.kind === "direct" ? getUnsupportedIframeProtocol(resolved.src) : null;

  let content: ReactNode;
  if (unsupportedProtocol) {
    content = (
      <View style={styles.container}>
        <Text style={titleStyle}>
          {t("workspace.browser.errors.unsupportedProtocol", { protocol: unsupportedProtocol })}
        </Text>
      </View>
    );
  } else if (!isWeb) {
    content = null;
  } else {
    content = (
      // Previews the user's own dev server (or an arbitrary site) like a real browser tab;
      // the daemon already strips X-Frame-Options/CSP so it runs unrestricted, and a sandbox
      // would break the scripts, forms, and popups a real page needs. Cross-origin isolation
      // already separates it from the Paseo origin.
      // oxlint-disable-next-line react/iframe-missing-sandbox
      <iframe
        key={reloadKey}
        src={resolved.src}
        style={IFRAME_STYLE}
        title={t("workspace.tabs.fallback.browser")}
      />
    );
  }

  return (
    <View style={styles.pane}>
      <View style={[styles.addressBar, { borderBottomColor: theme.colors.border }]}>
        {/* key remounts the field on url change so it resyncs to the canonical URL. */}
        <EditingTextInput
          ref={urlInputRef}
          key={url}
          initialValue={url}
          onSubmitEditing={submit}
          placeholder={t("workspace.browser.controls.enterUrl")}
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel={t("workspace.browser.controls.browserUrl")}
          autoCapitalize="none"
          autoCorrect={false}
          style={[
            styles.urlInput,
            { color: theme.colors.foreground, backgroundColor: theme.colors.input },
          ]}
        />
        <Pressable
          onPress={reload}
          accessibilityLabel={t("workspace.browser.controls.refresh")}
          style={styles.reloadButton}
        >
          <Text style={[styles.reloadGlyph, { color: theme.colors.foregroundMuted }]}>↻</Text>
        </Pressable>
      </View>
      {content}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pane: {
    flex: 1,
  },
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 16,
  },
  addressBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  urlInput: {
    flex: 1,
    height: 32,
    paddingHorizontal: 10,
    borderRadius: 8,
    fontSize: theme.fontSize.sm,
  },
  reloadButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  reloadGlyph: {
    fontSize: theme.fontSize.base,
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: "600",
  },
  subtitle: {
    fontSize: theme.fontSize.sm,
  },
}));
