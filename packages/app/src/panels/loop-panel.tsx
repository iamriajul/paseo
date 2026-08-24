import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { RefreshCw } from "lucide-react-native";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";

function useLoopPanelDescriptor(target: { kind: "loop"; loopId: string }): PanelDescriptor {
  const label = target.loopId;
  return {
    label,
    subtitle: "Loop",
    tooltip: label,
    titleState: "ready",
    icon: RefreshCw,
    statusBucket: null,
  };
}

function LoopPanel() {
  const { target } = usePaneContext();
  invariant(target.kind === "loop", "LoopPanel requires loop target");

  return (
    <View style={styles.root} testID="loop-panel">
      <View style={styles.header}>
        <Text style={styles.command} numberOfLines={2}>
          {target.loopId}
        </Text>
        <Text style={styles.meta}>Removed</Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.bodyText}>
          Official Paseo v0.4.0 removed chat rooms and the paseo loop backend. Heartbeats and
          schedules are unchanged. Close this tab.
        </Text>
      </View>
    </View>
  );
}

export const loopPanelRegistration: PanelRegistration<"loop"> = {
  kind: "loop",
  component: LoopPanel,
  useDescriptor: useLoopPanelDescriptor,
  resourceKey: (target) => target.loopId,
};

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    gap: theme.spacing[1],
  },
  command: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  body: {
    padding: theme.spacing[4],
  },
  bodyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
}));
