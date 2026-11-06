import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { GatewaySessionRoute } from "@getpaseo/protocol/messages";
import { formatAgo } from "@/usage/format";

export const gatewaySessionRouteCopy = {
  servedBy: "Served by",
  coolingDown: "cooling down",
  switched: "Switched",
} as const;

export interface SessionRouteRow {
  label: string;
  value: string;
}

/**
 * "Served by" always, then the newest switch when there is one, so a reader
 * who sees an unfamiliar account also sees when and why the session moved.
 */
export function buildSessionRouteRows(route: GatewaySessionRoute): SessionRouteRow[] {
  const account = [route.account.label, route.account.plan].filter(Boolean).join(" · ");
  const rows: SessionRouteRow[] = [
    {
      label: gatewaySessionRouteCopy.servedBy,
      value: route.account.inCooldown
        ? `${account} (${gatewaySessionRouteCopy.coolingDown})`
        : account,
    },
  ];
  // The account it left is in the quota list below and in the timeline notice,
  // so the row carries only when and why: a narrow sheet cannot fit two labels.
  const latest = route.switches.at(-1);
  if (latest) {
    const ago = formatAgo(latest.at);
    rows.push({
      label: gatewaySessionRouteCopy.switched,
      value: ago ? `${ago} (${latest.reason})` : latest.reason,
    });
  }
  return rows;
}

// Renders inside the context-meter details, above the CLIProxyAPI quota
// section. Returns nothing unless the daemon reports a route, so agents that
// are not Gateway-routed and Gateways without the route hide the section.
export function GatewaySessionRouteSection({ route }: { route: GatewaySessionRoute | null }) {
  if (!route) {
    return null;
  }
  return (
    <>
      <View style={styles.divider} />
      <View style={styles.rows}>
        {buildSessionRouteRows(route).map((row) => (
          <View key={row.label} style={styles.row}>
            <Text style={styles.label}>{row.label}</Text>
            <Text style={styles.value} numberOfLines={1}>
              {row.value}
            </Text>
          </View>
        ))}
      </View>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  divider: {
    height: 1,
    // Same rule the sibling CLIProxyAPI sections draw (see gateway-stats/section).
    backgroundColor: theme.colors.borderAccent,
    marginVertical: theme.spacing[2],
    marginHorizontal: -theme.spacing[2],
  },
  rows: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  value: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
    flexShrink: 1,
  },
}));
