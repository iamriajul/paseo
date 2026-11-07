import { useCallback } from "react";
import { View } from "react-native";
import { BringToFront } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { DensityIcon } from "@/components/ui/density-icon";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { getIsElectron } from "@/constants/platform";
import { useAppSettings } from "@/hooks/use-settings";
import { density } from "@/styles/density";

const TEST_ID = "sidebar-bring-to-front-toggle";
const ON_DATASET = { state: "on" };
const OFF_DATASET = { state: "off" };

/**
 * One-click switch for "Bring Paseo to the front" (`attentionIntrusiveMode`), the same setting as
 * Settings → Permissions → Attention. Desktop app only: only Electron can raise its window.
 */
export function SidebarBringToFrontToggle() {
  if (!getIsElectron()) {
    return null;
  }
  return <BringToFrontToggleButton />;
}

function BringToFrontToggleButton() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const enabled = settings.attentionIntrusiveMode;

  const handlePress = useCallback(() => {
    void updateSettings((current) => ({
      attentionIntrusiveMode: !current.attentionIntrusiveMode,
    }));
  }, [updateSettings]);

  // The label names the state and the action, so screen readers hear what a click does.
  const label = enabled
    ? t("sidebar.bringToFront.onTooltip")
    : t("sidebar.bringToFront.offTooltip");

  return (
    <ToolbarButton
      round
      label={label}
      tooltipSide="top"
      style={styles.button}
      testID={TEST_ID}
      nativeID={TEST_ID}
      dataSet={enabled ? ON_DATASET : OFF_DATASET}
      onPress={handlePress}
    >
      <View style={styles.glyph}>
        <DensityIcon icon={BringToFront} size="md" color={enabled ? "accent" : "foregroundMuted"} />
        {enabled ? null : <View pointerEvents="none" style={styles.strike} />}
      </View>
    </ToolbarButton>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    width: density.iconButton,
    height: density.iconButton,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  glyph: {
    alignItems: "center",
    justifyContent: "center",
  },
  // A slash across the glyph marks "off", the way muted-bell icons do. It carries a ring in the
  // sidebar colour so it reads as cut through the icon rather than drawn on top of it.
  strike: {
    position: "absolute",
    width: "130%",
    height: 2,
    borderRadius: 1,
    backgroundColor: theme.colors.foregroundMuted,
    outlineWidth: 1,
    outlineStyle: "solid",
    outlineColor: theme.colors.surfaceSidebar,
    transform: [{ rotate: "-45deg" }],
  },
}));
