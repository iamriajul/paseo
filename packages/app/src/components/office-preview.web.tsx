import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, type LayoutChangeEvent, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { officePreviewTransferMessages } from "@/components/office-preview-bytes";
import type { OfficePreviewKind } from "@/file-explorer/office";
import type { OfficePreviewProps } from "./office-preview";

// Same isolation as the HTML preview. allow-scripts with no allow-same-origin
// gives the document an opaque origin, so a file that injects markup cannot
// reach the app document, its storage, or the daemon socket.
const SANDBOX = "allow-scripts";
const BRIDGE_READY_TIMEOUT_MS = 8_000;

type PreviewPhase = "loading" | "ready" | "failed";

const frameStyle = {
  flex: 1,
  width: "100%",
  height: "100%",
  border: "none",
  backgroundColor: "white",
} as const;

const hiddenFrameStyle = {
  ...frameStyle,
  display: "none",
} as const;

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

function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const size = 0x8000;
  for (let index = 0; index < bytes.length; index += size) {
    parts.push(String.fromCharCode(...bytes.subarray(index, index + size)));
  }
  return btoa(parts.join(""));
}

export function OfficePreview({ uri, label, kind }: OfficePreviewProps) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [phase, setPhase] = useState<PreviewPhase>("loading");
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [bridgeReady, setBridgeReady] = useState(false);
  const measurePane = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    const nextHeight = event.nativeEvent.layout.height;
    if (nextWidth > 0) setWidth((current) => (current > 0 ? current : nextWidth));
    if (nextHeight > 0) setHeight((current) => (current > 0 ? current : nextHeight));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setPhase("loading");
    setBridgeReady(false);
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
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: string } | null;
      if (data?.type === "bridgeReady") setBridgeReady(true);
      if (data?.type === "ready") setPhase("ready");
      if (data?.type === "failed") setPhase("failed");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const frame = frameRef.current?.contentWindow;
    if (!frame || !bridgeReady || width <= 0 || height <= 0) return;
    let cancelled = false;
    setPhase("loading");
    void (async () => {
      try {
        const response = await fetch(uri);
        if (!response.ok) throw new Error("preview fetch failed");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (cancelled) return;
        const base64 = bytesToBase64(bytes);
        for (const message of officePreviewTransferMessages({ kind, width, height, base64 })) {
          frame.postMessage(message, "*");
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
      {html ? (
        <iframe
          ref={frameRef}
          title={label}
          srcDoc={html}
          sandbox={SANDBOX}
          referrerPolicy="no-referrer"
          style={phase === "failed" ? hiddenFrameStyle : frameStyle}
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
