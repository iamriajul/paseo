import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, type LayoutChangeEvent, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import * as FileSystem from "expo-file-system/legacy";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  officePreviewTransferMessages,
  type OfficePreviewInbound,
} from "@/components/office-preview-bytes";
import type { OfficePreviewKind } from "@/file-explorer/office";
import { htmlPreviewNavigationKind } from "@/file-pane/html-preview-navigation";
import type { OfficePreviewProps } from "./office-preview";

// Same rule as the HTML preview: this WebView is a viewer. The bundled document
// loads once, and later navigations are refused so the file cannot browse away.
const ORIGIN_WHITELIST = ["*"];
const BASE_URL = "about:blank";
const BRIDGE_READY_TIMEOUT_MS = 8_000;

type PreviewPhase = "loading" | "ready" | "failed";

function loadOfficePreviewHtml(kind: OfficePreviewKind): Promise<string> {
  if (kind === "docx") {
    return import("./office-preview-webview-docx-html").then(
      (mod) => mod.officePreviewDocxWebViewHtml,
    );
  }
  if (kind === "xlsx") {
    return import("./office-preview-webview-xlsx-html").then(
      (mod) => mod.officePreviewXlsxWebViewHtml,
    );
  }
  return import("./office-preview-webview-pptx-html").then(
    (mod) => mod.officePreviewPptxWebViewHtml,
  );
}

function scriptForMessage(message: OfficePreviewInbound): string {
  const payload = JSON.stringify(message).replace(/<\/script/gi, "<\\/script");
  return `window.__PASEO_OFFICE_PREVIEW_RECEIVE__ && window.__PASEO_OFFICE_PREVIEW_RECEIVE__(${payload}); true;`;
}

export function OfficePreview({ uri, label, kind }: OfficePreviewProps) {
  const { t } = useTranslation();
  const webViewRef = useRef<WebView>(null);
  const loadedDocumentRef = useRef(false);
  const [html, setHtml] = useState<string | null>(null);
  const [phase, setPhase] = useState<PreviewPhase>("loading");
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [mountId, setMountId] = useState(0);
  const [bridgeReady, setBridgeReady] = useState(false);
  const rendererGoneRef = useRef(false);
  const source = useMemo(() => (html === null ? null : { html, baseUrl: BASE_URL }), [html]);
  const measurePane = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    const nextHeight = event.nativeEvent.layout.height;
    if (nextWidth > 0) setWidth((current) => (current > 0 ? current : nextWidth));
    if (nextHeight > 0) setHeight((current) => (current > 0 ? current : nextHeight));
  }, []);
  const allowOnlyInitialDocument = useCallback(({ url }: { url: string }) => {
    const navigationKind = htmlPreviewNavigationKind(url);
    if (navigationKind === "fragment") return true;
    if (navigationKind === "blocked") return false;
    if (loadedDocumentRef.current) return false;
    loadedDocumentRef.current = true;
    return true;
  }, []);
  const onMessage = useCallback((event: WebViewMessageEvent) => {
    let message: { type?: string };
    try {
      message = JSON.parse(event.nativeEvent.data) as { type?: string };
    } catch {
      return;
    }
    if (message.type === "bridgeReady") setBridgeReady(true);
    if (message.type === "ready") setPhase("ready");
    if (message.type === "failed") setPhase("failed");
  }, []);
  const markRendererGone = useCallback(() => {
    setBridgeReady(false);
    setPhase("failed");
    if (rendererGoneRef.current) return;
    rendererGoneRef.current = true;
    loadedDocumentRef.current = false;
    setMountId((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setPhase("loading");
    setBridgeReady(false);
    loadedDocumentRef.current = false;
    void (async () => {
      try {
        const nextHtml = await loadOfficePreviewHtml(kind);
        if (!cancelled) setHtml(nextHtml);
      } catch {
        if (!cancelled) setPhase("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind]);

  useEffect(() => {
    if (!html || bridgeReady) return;
    const timer = setTimeout(() => setPhase("failed"), BRIDGE_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [bridgeReady, html, kind]);

  useEffect(() => {
    rendererGoneRef.current = false;
  }, [kind, uri]);

  useEffect(() => {
    const webView = webViewRef.current;
    if (!webView || !bridgeReady || width <= 0 || height <= 0) return;
    if (rendererGoneRef.current) return;
    let cancelled = false;
    setPhase("loading");
    void (async () => {
      try {
        const base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        if (cancelled) return;
        for (const message of officePreviewTransferMessages({ kind, width, height, base64 })) {
          webView.injectJavaScript(scriptForMessage(message));
        }
      } catch {
        if (!cancelled) setPhase("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridgeReady, height, kind, uri, width]);

  return (
    <View
      style={styles.container}
      accessibilityLabel={label}
      testID="office-file-preview"
      onLayout={measurePane}
    >
      {source ? (
        <WebView
          ref={webViewRef}
          key={`${kind}:${mountId}`}
          style={phase === "failed" ? styles.hidden : styles.webview}
          source={source}
          originWhitelist={ORIGIN_WHITELIST}
          onShouldStartLoadWithRequest={allowOnlyInitialDocument}
          onMessage={onMessage}
          onContentProcessDidTerminate={markRendererGone}
          onRenderProcessGone={markRendererGone}
          setSupportMultipleWindows={false}
          javaScriptCanOpenWindowsAutomatically={false}
          domStorageEnabled={false}
          thirdPartyCookiesEnabled={false}
          cacheEnabled={false}
          incognito
        />
      ) : null}
      {phase === "loading" ? (
        <View style={styles.loading}>
          <ActivityIndicator size="small" />
        </View>
      ) : null}
      {phase === "failed" ? (
        <View style={styles.centerState}>
          <Text style={styles.errorText}>{t("panels.file.failedToLoadPreview")}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  webview: {
    flex: 1,
    minHeight: 0,
    backgroundColor: "white",
  },
  hidden: {
    display: "none",
  },
  loading: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
