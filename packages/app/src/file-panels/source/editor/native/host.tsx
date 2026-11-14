import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { StyleSheet } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { htmlPreviewNavigationKind } from "@/file-panels/html-preview-navigation";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { EditorVisualTheme } from "../extensions.web";
import type { FileEditorModel } from "../model";
import {
  parseNativeEditorEvent,
  type NativeEditorCommand,
  type NativeEditorConfiguration,
} from "./bridge";
import { NativeEditorSession } from "./session";
import { sourceEditorWebViewHtml } from "./webview-html";

interface FileEditorViewProps {
  model: FileEditorModel;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  vimEnabled: boolean;
  theme: EditorVisualTheme;
  onCursorChange(position: { line: number; column: number }): void;
  onVimModeChange(mode: string | null): void;
  /** The editor shows the file's content. */
  onReady(): void;
}

const BASE_URL = "about:blank";
const ORIGIN_WHITELIST = ["*"];
const SOURCE = { html: sourceEditorWebViewHtml, baseUrl: BASE_URL };
let nextEditorKey = 1;

/**
 * The web editor's CodeMirror, run in a WebView from a bundled page. The page shows and edits the
 * text; this host keeps `model` as the file's one buffer, so saving, conflicts and line endings
 * behave as on web.
 */
export function FileEditorView({
  model,
  filename,
  location,
  navigationRevision,
  vimEnabled,
  theme,
  onCursorChange,
  onVimModeChange,
  onReady,
}: FileEditorViewProps) {
  const webViewRef = useRef<WebView>(null);
  const bridgeReady = useRef(false);
  const loadedDocument = useRef(false);
  const callbacks = useRef({ onCursorChange, onVimModeChange, onReady });
  callbacks.current = { onCursorChange, onVimModeChange, onReady };
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const [session] = useState(
    () =>
      new NativeEditorSession({
        editorKey: `native-source-editor-${nextEditorKey++}`,
        content: snapshot.content,
        lineSeparator: snapshot.lineSeparator,
        callbacks: {
          onEdit: (content) => model.edit(content),
          onSave: () => void model.save(),
          onCursorChange: (position) => callbacks.current.onCursorChange(position),
          onVimModeChange: (mode) => callbacks.current.onVimModeChange(mode),
          onReady: () => callbacks.current.onReady(),
        },
      }),
  );
  // The themed wrapper hands a new theme object on every render, and the toolbar re-renders on
  // every cursor move. Reconfiguring per keystroke would reset vim's mode, so compare by value.
  const configurationJson = JSON.stringify({ filename, vimEnabled, theme });
  const configuration = useMemo<NativeEditorConfiguration>(
    () => JSON.parse(configurationJson),
    [configurationJson],
  );
  const latest = useRef({ configuration, location });
  latest.current = { configuration, location };

  const send = useCallback((command: NativeEditorCommand) => {
    if (!bridgeReady.current) return;
    const payload = JSON.stringify(JSON.stringify(command));
    webViewRef.current?.injectJavaScript(
      `window.__PASEO_SOURCE_EDITOR_RECEIVE__ && window.__PASEO_SOURCE_EDITOR_RECEIVE__(${payload}); true;`,
    );
  }, []);
  const reveal = useCallback(
    ({ lineStart, lineEnd }: WorkspaceFileLocation) => {
      if (lineStart) send({ type: "reveal", editorKey: session.editorKey, lineStart, lineEnd });
    },
    [send, session],
  );

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parseNativeEditorEvent(event.nativeEvent.data);
      if (!message) return;
      if (message.type !== "bridgeReady") {
        session.receive(message);
        return;
      }
      // A fresh page, first load or a reload after its renderer died: it gets the current text.
      bridgeReady.current = true;
      send(session.mount(latest.current.configuration));
      reveal(latest.current.location);
    },
    [reveal, send, session],
  );

  useEffect(() => {
    const command = session.sync(snapshot.content, snapshot.lineSeparator);
    if (command) send(command);
  }, [send, session, snapshot.content, snapshot.lineSeparator]);

  useEffect(() => {
    send({ type: "configure", editorKey: session.editorKey, configuration });
  }, [configuration, send, session]);

  useEffect(() => {
    reveal({ path: location.path, lineStart: location.lineStart, lineEnd: location.lineEnd });
  }, [location.lineEnd, location.lineStart, location.path, navigationRevision, reveal]);

  const allowOnlyTheEditorPage = useCallback(({ url }: { url: string }) => {
    const kind = htmlPreviewNavigationKind(url);
    if (kind === "fragment") return true;
    if (kind === "blocked" || loadedDocument.current) return false;
    loadedDocument.current = true;
    return true;
  }, []);
  const handleLoadStart = useCallback(() => {
    bridgeReady.current = false;
  }, []);
  const reloadAfterRendererLoss = useCallback(() => {
    bridgeReady.current = false;
    loadedDocument.current = false;
    webViewRef.current?.reload();
  }, []);
  const handleRenderProcessGone = useCallback(() => {
    reloadAfterRendererLoss();
    return true;
  }, [reloadAfterRendererLoss]);

  const style = useMemo(
    () => [styles.webview, { backgroundColor: theme.background }],
    [theme.background],
  );
  return (
    <WebView
      ref={webViewRef}
      testID="file-source-editor"
      accessibilityLabel={`Source editor for ${filename}`}
      style={style}
      source={SOURCE}
      originWhitelist={ORIGIN_WHITELIST}
      onShouldStartLoadWithRequest={allowOnlyTheEditorPage}
      onMessage={handleMessage}
      onLoadStart={handleLoadStart}
      onContentProcessDidTerminate={reloadAfterRendererLoss}
      onRenderProcessGone={handleRenderProcessGone}
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      domStorageEnabled={false}
      thirdPartyCookiesEnabled={false}
      cacheEnabled={false}
      incognito
      scrollEnabled={false}
      overScrollMode="never"
      keyboardDisplayRequiresUserAction={false}
      hideKeyboardAccessoryView
    />
  );
}

const styles = StyleSheet.create({
  webview: { flex: 1, minHeight: 0 },
});
