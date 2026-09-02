import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { Code, Workflow } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { ZoomableViewport } from "@/components/zoomable-viewport";
import type { Theme } from "@/styles/theme";
import type { MarkdownFenceRendererProps } from "../types";
import type { MermaidRenderRequest } from "./render-model";
import { mermaidRuntimeHtml } from "./runtime/html.gen";
import { parseMermaidRuntimeMessage, type MermaidRuntimeRenderMessage } from "./runtime/messages";
import { MermaidRuntimeRequestDriver } from "./runtime/request-driver";
import { useMermaidRenderModel } from "./use-render-model";
import {
  getDiagramBoxLayoutStyle,
  getDiagramBoxStyle,
  getDiagramFit,
  getMeasuringContentSize,
  getRenderedContentSize,
  MEASURING_BOX_HEIGHT,
} from "./presentation";

interface MermaidIframeRuntimeProps {
  request: MermaidRenderRequest | null;
  height: React.CSSProperties["height"];
  onRendered: (message: {
    revision: number;
    source: string;
    colorScheme: "light" | "dark";
    height: number;
    width: number;
  }) => void;
  onRenderFailed: (revision: number, message?: string) => void;
}

function MermaidIframeRuntime({
  request,
  height,
  onRendered,
  onRenderFailed,
}: MermaidIframeRuntimeProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const driverRef = useRef<MermaidRuntimeRequestDriver | null>(null);
  driverRef.current ??= new MermaidRuntimeRequestDriver();
  const iframeStyle = useMemo<React.CSSProperties>(
    () => ({
      display: "block",
      width: "100%",
      height,
      border: 0,
      pointerEvents: "none",
      background: "transparent",
    }),
    [height],
  );

  const sendRequest = useCallback((current: MermaidRenderRequest | null) => {
    const target = iframeRef.current?.contentWindow;
    if (!current || !target) return;
    const message: MermaidRuntimeRenderMessage = {
      type: "render",
      revision: current.revision,
      source: current.source,
      colorScheme: current.colorScheme,
      interactive: false,
    };
    target.postMessage(message, "*");
  }, []);

  useEffect(() => {
    sendRequest(driverRef.current?.update(request) ?? null);
  }, [request, sendRequest]);

  useEffect(() => {
    function receiveMessage(event: MessageEvent): void {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = parseMermaidRuntimeMessage(event.data);
      if (!message) return;
      if (message.type === "bridgeReady") {
        sendRequest(driverRef.current?.ready() ?? null);
        return;
      }
      if (message.type === "renderError") {
        onRenderFailed(message.revision, message.message);
        sendRequest(driverRef.current?.settled(message.revision, false) ?? null);
        return;
      }
      onRendered(message);
      sendRequest(driverRef.current?.settled(message.revision, true) ?? null);
    }
    window.addEventListener("message", receiveMessage);
    return () => window.removeEventListener("message", receiveMessage);
  }, [onRenderFailed, onRendered, sendRequest]);

  return (
    <iframe
      ref={iframeRef}
      title=""
      aria-hidden
      sandbox="allow-scripts"
      srcDoc={mermaidRuntimeHtml}
      tabIndex={-1}
      style={iframeStyle}
    />
  );
}

interface MermaidFenceHostImplProps extends MarkdownFenceRendererProps {
  colorScheme?: "light" | "dark";
}

function MermaidFenceHostImpl({
  code,
  phase,
  inheritedStyles,
  textStyle,
  colorScheme = "dark",
}: MermaidFenceHostImplProps) {
  const { t } = useTranslation();
  const { state, request, rendered, renderFailed } = useMermaidRenderModel({
    source: code,
    phase,
    colorScheme,
  });
  const [hasRuntimeContent, setHasRuntimeContent] = useState(false);
  const [columnWidth, setColumnWidth] = useState<number | null>(null);
  const [showSource, setShowSource] = useState(false);
  // The measuring overlay is `left: 0; right: 0` inside this host, so the host's own width is the
  // width the runtime is laid out at — and the width mermaid has to fit the diagram to.
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    if (width > 0) setColumnWidth((current) => (current === width ? current : width));
  }, []);
  const showSourcePress = useCallback(() => setShowSource(true), []);
  const showDiagramPress = useCallback(() => setShowSource(false), []);
  const handleRendered = useCallback(
    (message: {
      revision: number;
      source: string;
      colorScheme: "light" | "dark";
      height: number;
      width: number;
    }) => {
      setHasRuntimeContent(true);
      rendered({
        revision: message.revision,
        source: message.source,
        colorScheme: message.colorScheme,
        dimensions: { height: message.height, width: message.width },
      });
    },
    [rendered],
  );
  const visible = state.visible;
  const canShowDiagram = visible !== null && hasRuntimeContent;
  const diagramVisible = canShowDiagram && !showSource;
  const runtimeHeight = Math.max(visible?.height ?? 240, 1);
  const actions = useMemo(
    () => [
      {
        icon: Code,
        label: t("message.diagram.viewSource"),
        onPress: showSourcePress,
      },
    ],
    [showSourcePress, t],
  );
  const sourceView = useMemo(() => {
    const { marginTop, marginBottom, marginVertical, ...sourceTextStyle } = textStyle;
    const margins: ViewStyle = {
      marginTop: marginTop ?? marginVertical,
      marginBottom: marginBottom ?? marginVertical,
    };
    const text: TextStyle = sourceTextStyle;
    return { container: [margins, sourceContainerStyle], text };
  }, [textStyle]);
  const diagramStyle = useMemo(
    () => [
      getDiagramBoxStyle(textStyle),
      containerStyle,
      getDiagramBoxLayoutStyle(textStyle, runtimeHeight),
    ],
    [runtimeHeight, textStyle],
  );
  const diagramFit = useMemo(() => getDiagramFit(textStyle), [textStyle]);
  const diagramSize = useMemo(
    () =>
      visible
        ? getRenderedContentSize(textStyle, columnWidth, visible)
        : getMeasuringContentSize(columnWidth),
    [columnWidth, textStyle, visible],
  );
  const sourceVisible = !diagramVisible;
  const sourceContainer = showSource ? sourceView.container : sourceContainerStyle;
  const sourceTextStyle = showSource ? sourceView.text : textStyle;
  const viewportStyle = diagramVisible ? diagramStyle : measuringStyle;

  return (
    <View onLayout={handleLayout}>
      {sourceVisible ? (
        <View style={sourceContainer}>
          {state.status === "failed" && state.errorMessage ? (
            <Text style={controlStyles.errorCaption}>
              {t("message.diagram.renderError", { message: state.errorMessage })}
            </Text>
          ) : null}
          <HighlightedCodeBlock
            code={code}
            language="mermaid"
            inheritedStyles={inheritedStyles}
            textStyle={sourceTextStyle}
          />
          {showSource && canShowDiagram ? (
            <Pressable
              accessibilityLabel={t("message.diagram.viewDiagram")}
              accessibilityRole="button"
              hitSlop={4}
              onPress={showDiagramPress}
              style={controlStyles.sourceButton}
            >
              {({ hovered }) => (
                <Workflow
                  size={14}
                  color={hovered ? controlStyles.iconHovered.color : controlStyles.icon.color}
                />
              )}
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <ZoomableViewport
        accessibilityLabel={t("message.diagram.diagram")}
        actions={actions}
        contentSize={diagramSize}
        fit={diagramVisible ? diagramFit : undefined}
        style={viewportStyle}
        testID="mermaid-viewport"
        wheelActivation="modifier"
      >
        <MermaidIframeRuntime
          request={request}
          height="100%"
          onRendered={handleRendered}
          onRenderFailed={renderFailed}
        />
      </ZoomableViewport>
    </View>
  );
}

const sourceContainerStyle: ViewStyle = { position: "relative" };
const containerStyle: ViewStyle = { overflow: "hidden", position: "relative" };
const measuringStyle: ViewStyle = {
  position: "absolute",
  left: 0,
  right: 0,
  top: 0,
  height: MEASURING_BOX_HEIGHT,
  opacity: 0,
  pointerEvents: "none",
};
const controlStyles = StyleSheet.create((theme) => ({
  sourceButton: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[2],
    padding: theme.spacing[1],
  },
  icon: { color: theme.colors.foregroundMuted },
  iconHovered: { color: theme.colors.foreground },
  errorCaption: {
    color: theme.colors.foregroundMuted,
    fontSize: 12,
    paddingBottom: theme.spacing[1],
  },
}));
const mapColorScheme = (theme: Theme) => ({ colorScheme: theme.colorScheme });
const ThemedMermaidFenceHost = withUnistyles(MermaidFenceHostImpl);

export function MermaidFenceHost(props: MarkdownFenceRendererProps) {
  return <ThemedMermaidFenceHost {...props} uniProps={mapColorScheme} />;
}
