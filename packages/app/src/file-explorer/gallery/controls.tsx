import { Text, View } from "react-native";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import type { Theme } from "@/styles/theme";

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronRight = withUnistyles(ChevronRight);
const iconColor = (theme: Theme) => ({ color: theme.colors.foreground });

/** Previous and next on the image's edges, and its place in the folder at the bottom. */
export function GalleryControls({
  index,
  count,
  visible,
  onPrevious,
  onNext,
}: {
  index: number;
  count: number;
  /** Hover-revealed on desktop; always shown on touch, native and compact layouts. */
  visible: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  const position = { current: index + 1, total: count };
  return (
    <>
      <View style={[styles.edge, styles.edgeStart]} pointerEvents="box-none">
        <GalleryButton
          side="previous"
          label={t("workspace.fileExplorer.gallery.previous")}
          shown={visible && index > 0}
          onPress={onPrevious}
        />
      </View>
      <View style={[styles.edge, styles.edgeEnd]} pointerEvents="box-none">
        <GalleryButton
          side="next"
          label={t("workspace.fileExplorer.gallery.next")}
          shown={visible && index < count - 1}
          onPress={onNext}
        />
      </View>
      <View style={styles.positionRail} pointerEvents="none">
        <View style={styles.position}>
          <Text
            style={styles.positionText}
            accessibilityLabel={t("workspace.fileExplorer.gallery.positionLabel", position)}
            testID="image-gallery-position"
          >
            {t("workspace.fileExplorer.gallery.position", position)}
          </Text>
        </View>
      </View>
    </>
  );
}

function GalleryButton({
  side,
  label,
  shown,
  onPress,
}: {
  side: "previous" | "next";
  label: string;
  shown: boolean;
  onPress: () => void;
}) {
  const isCompact = useIsCompactFormFactor();
  const glyph = paneContentToolbarIconSize(isCompact);
  return (
    // Hidden with opacity, not unmounted, so revealing it never moves anything under the cursor.
    // The slot hides it: a disabled ToolbarButton would paint its own half-opacity state.
    <View
      style={[styles.slot, !shown && styles.slotHidden]}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
      testID={`image-gallery-${side}-slot`}
    >
      <ToolbarButton
        label={label}
        compact={isCompact}
        round
        hitSlop={8}
        onPress={onPress}
        style={styles.button}
        testID={`image-gallery-${side}`}
      >
        {side === "previous" ? (
          <ThemedChevronLeft size={glyph} uniProps={iconColor} />
        ) : (
          <ThemedChevronRight size={glyph} uniProps={iconColor} />
        )}
      </ToolbarButton>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  edge: {
    position: "absolute",
    top: 0,
    bottom: 0,
    justifyContent: "center",
    zIndex: 1,
  },
  edgeStart: { left: theme.spacing[2] },
  edgeEnd: { right: theme.spacing[2] },
  // Larger than a toolbar glyph: it sits over an image and is the main way to page with a mouse.
  button: {
    width: 32,
    height: 32,
    backgroundColor: theme.colors.surface2,
  },
  slot: {
    opacity: 1,
  },
  slotHidden: {
    opacity: 0,
    pointerEvents: "none",
  },
  positionRail: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: theme.spacing[3],
    alignItems: "center",
    zIndex: 1,
  },
  position: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  positionText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
