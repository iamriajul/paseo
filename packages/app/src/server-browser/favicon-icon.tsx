import { useMemo, type ComponentType } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Server } from "lucide-react-native";
import { PlatformImage } from "@/components/zoomable-viewport/platform-image";
import type { PanelIconProps } from "@/panels/panel-registry";

/**
 * The page's icon, which the host reads so it shows on every client, with the server mark in its
 * corner so the tab still reads as a server tab. `PlatformImage` draws it with expo-image on
 * phones, where React Native's Image cannot decode SVG (Vite's default favicon is one).
 */
export function createFaviconTabIcon(favicon: string): ComponentType<PanelIconProps> {
  return function ServerBrowserFaviconIcon({ size, color }: PanelIconProps) {
    const imageStyle = useMemo(() => ({ width: size, height: size, borderRadius: 3 }), [size]);
    const badgeSize = Math.max(8, Math.round(size * 0.55));
    const badgeStyle = useMemo(
      () => [styles.badge, { right: -badgeSize / 3, bottom: -badgeSize / 3 }],
      [badgeSize],
    );
    return (
      <View testID="server-browser-tab-favicon">
        <PlatformImage uri={favicon} style={imageStyle} testID="server-browser-tab-favicon-image" />
        <View style={badgeStyle}>
          <Server size={badgeSize} color={color} />
        </View>
      </View>
    );
  };
}

/** The tab's favicon icon, kept while the favicon is the same so the tab does not remount it. */
export function useFaviconTabIcon(
  favicon: string | undefined,
): ComponentType<PanelIconProps> | null {
  return useMemo(() => (favicon ? createFaviconTabIcon(favicon) : null), [favicon]);
}

const styles = StyleSheet.create((theme) => ({
  badge: {
    position: "absolute",
    borderRadius: 3,
    padding: 1,
    backgroundColor: theme.colors.surface0,
  },
}));
