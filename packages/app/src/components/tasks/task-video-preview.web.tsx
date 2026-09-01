import { useMemo, type CSSProperties } from "react";
import { View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";

const videoStyle = {
  width: "100%",
  height: "100%",
  objectFit: "contain",
  display: "block",
} satisfies CSSProperties;

export function TaskVideoPreview({ uri, style }: { uri: string; style?: StyleProp<ViewStyle> }) {
  const video = useMemo(
    () => (
      // React Native Web has no first-class video primitive. This web-only file
      // keeps the DOM element out of native bundles.
      <video controls src={uri} style={videoStyle} />
    ),
    [uri],
  );

  return <View style={style}>{video}</View>;
}
