import { useMemo, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { DensityIcon } from "@/components/ui/density-icon";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { density } from "@/styles/density";

/** A sidebar section label such as "Pinned" or "Workspaces". A section with `onToggle`
 * collapses from its title; children sit at the trailing edge as its actions. */
export function SidebarSectionHeader({
  title,
  collapsed,
  onToggle,
  testID,
  titleAccessory,
  onLayout,
  children,
}: {
  title: string;
  collapsed?: boolean;
  onToggle?: () => void;
  testID?: string;
  /** Sits right after the title, e.g. the Workspaces group-mode control. */
  titleAccessory?: ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
  children?: ReactNode;
}) {
  const titleNode = onToggle ? (
    <CollapsibleTitle
      title={title}
      collapsed={collapsed ?? false}
      onToggle={onToggle}
      testID={testID}
    />
  ) : (
    <Text style={styles.title} numberOfLines={1} testID={testID}>
      {title}
    </Text>
  );
  return (
    <View style={styles.header} onLayout={onLayout}>
      {titleAccessory ? (
        <View style={styles.leading}>
          {titleNode}
          {titleAccessory}
        </View>
      ) : (
        titleNode
      )}
      {children ? <View style={styles.actions}>{children}</View> : null}
    </View>
  );
}

function CollapsibleTitle({
  title,
  collapsed,
  onToggle,
  testID,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  testID?: string;
}) {
  const isCompact = useIsCompactFormFactor();
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={onToggle}
      style={styles.toggle}
      testID={testID}
    >
      {({ hovered }) => (
        <>
          <Text style={styles.title}>{title}</Text>
          {hovered || isNative || isCompact ? (
            <DensityIcon
              icon={collapsed ? ChevronRight : ChevronDown}
              size="xs"
              color="foregroundMuted"
            />
          ) : null}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    minHeight: density.rowHeight,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    // The title lands at spacing[2] to align with the rows' leading icons. Trailing actions
    // are icon buttons whose painted glyph stops inside the SVG box, so 4px aligns the ink
    // rather than the box to the row rail.
    paddingLeft: theme.spacing[2],
    paddingRight: 4,
    userSelect: "none",
  },
  // The toggle reaches back over the header's leading padding so the whole label edge is pressable.
  toggle: {
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginLeft: -theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  leading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flex: 1,
    minWidth: 0,
  },
  title: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
}));
