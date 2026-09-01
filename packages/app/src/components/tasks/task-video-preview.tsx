import { useMemo } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { WebView } from "react-native-webview";

export function TaskVideoPreview({ uri, style }: { uri: string; style?: StyleProp<ViewStyle> }) {
  const html = useMemo(
    () => `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
    <style>
      html, body { margin: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
      video { width: 100%; height: 100%; object-fit: contain; display: block; }
    </style>
  </head>
  <body>
    <video controls src="${escapeHtmlAttribute(uri)}"></video>
  </body>
</html>`,
    [uri],
  );
  const source = useMemo(() => ({ html }), [html]);

  return (
    <WebView
      source={source}
      style={style}
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
    />
  );
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
