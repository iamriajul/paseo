import { useCallback, useMemo } from "react";
import {
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { LucideIcon } from "lucide-react-native";
import { HEADER_INNER_HEIGHT, HEADER_INNER_HEIGHT_MOBILE } from "@/constants/layout";
import { ICON_SIZE } from "@/styles/theme";
import type { Theme } from "@/styles/theme";
import { Shortcut } from "@/components/ui/shortcut";
import type { ShortcutKey } from "@/utils/format-shortcut";

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type SidebarHeaderRowVariant = "header" | "compact";

interface SidebarHeaderRowAction {
  icon: LucideIcon;
  onPress: () => void;
  accessibilityLabel: string;
  testID?: string;
}

interface SidebarHeaderRowProps {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  isActive?: boolean;
  testID?: string;
  nativeID?: string;
  accessibilityLabel?: string;
  /**
   * "header" (default): a sidebar-height row with its own bottom separator —
   * the lone header at the top of a sidebar (settings "Back to workspace").
   * "compact": a row with no separator, for entries that
   * sit in a header group whose wrapper owns the single divider.
   */
  variant?: SidebarHeaderRowVariant;
  shortcutKeys?: ShortcutKey[][] | null;
  trailingAction?: SidebarHeaderRowAction | null;
}

export function SidebarHeaderRow({
  icon: Icon,
  label,
  onPress,
  isActive = false,
  testID,
  nativeID,
  accessibilityLabel,
  variant = "header",
  shortcutKeys = null,
  trailingAction = null,
}: SidebarHeaderRowProps) {
  const ThemedIcon = useMemo(() => withUnistyles(Icon), [Icon]);
  const ThemedTrailingIcon = useMemo(
    () => (trailingAction ? withUnistyles(trailingAction.icon) : null),
    [trailingAction],
  );

  const containerStyle = useMemo(
    () => (variant === "compact" ? styles.containerCompact : styles.container),
    [variant],
  );

  const buttonStyle = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.button,
      trailingAction ? styles.buttonWithTrailingAction : null,
      (Boolean(hovered) || isActive) && styles.buttonHovered,
    ],
    [isActive, trailingAction],
  );

  const handleTrailingPress = useCallback(
    (event: GestureResponderEvent) => {
      // Trailing action is a sibling of the row press target, but still stop
      // propagation so nested gesture handlers never treat this as a row press.
      event.stopPropagation();
      trailingAction?.onPress();
    },
    [trailingAction],
  );

  const renderChildren = useCallback(
    (state: PressableStateCallbackType & { hovered?: boolean }) => {
      const isHighlighted = Boolean(state.hovered) || isActive;
      return (
        <>
          <ThemedIcon
            size={variant === "compact" ? ICON_SIZE.sm : ICON_SIZE.md}
            uniProps={isHighlighted ? foregroundColorMapping : foregroundMutedColorMapping}
          />
          <SidebarHeaderRowLabel label={label} isHighlighted={isHighlighted} />
          {shortcutKeys && Boolean(state.hovered) && !trailingAction ? (
            <Shortcut chord={shortcutKeys} style={styles.shortcut} />
          ) : null}
        </>
      );
    },
    [ThemedIcon, isActive, label, shortcutKeys, trailingAction, variant],
  );

  return (
    <View style={containerStyle}>
      <View style={styles.row}>
        <Pressable
          onPress={onPress}
          testID={testID}
          nativeID={nativeID}
          accessible
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? label}
          style={buttonStyle}
        >
          {renderChildren}
        </Pressable>
        {trailingAction && ThemedTrailingIcon ? (
          <Pressable
            onPress={handleTrailingPress}
            accessibilityRole="button"
            accessibilityLabel={trailingAction.accessibilityLabel}
            testID={trailingAction.testID}
            hitSlop={8}
            style={styles.trailingAction}
          >
            {({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => (
              <ThemedTrailingIcon
                size={ICON_SIZE.sm}
                uniProps={
                  Boolean(hovered) || isActive
                    ? foregroundColorMapping
                    : foregroundMutedColorMapping
                }
              />
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function SidebarHeaderRowLabel({
  label,
  isHighlighted,
}: {
  label: string;
  isHighlighted: boolean;
}) {
  const labelStyle = useMemo(
    () => [styles.label, isHighlighted && styles.labelHighlighted],
    [isHighlighted],
  );
  return <Text style={labelStyle}>{label}</Text>;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    userSelect: "none",
  },
  containerCompact: {
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    userSelect: "none",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    // Same row geometry as the settings sidebar items. Shorter than the header
    // strip so the hover highlight clears the strip's bottom separator.
    minHeight: 28,
    paddingVertical: theme.spacing[1],
    // Match the project rows' inner padding so the icons align on one vertical
    // edge with the list below.
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  buttonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  buttonWithTrailingAction: {
    // Button fills the row so the trailing action sits at the row end.
    flex: 1,
    minWidth: 0,
    // Keep room for the trailing action without shifting the label under it.
    paddingRight: theme.spacing[1],
  },
  label: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  labelHighlighted: {
    color: theme.colors.foreground,
  },
  shortcut: {
    marginLeft: "auto",
  },
  trailingAction: {
    minWidth: 28,
    minHeight: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
}));
