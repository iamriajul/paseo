import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { GatewayAccountChange } from "@getpaseo/protocol/agent-cache-warm";
import type { GatewaySessionRoute } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import {
  buildLastServedRows,
  buildSessionRouteRows,
  type SessionRouteRow,
} from "@/gateway-session-route/route-rows";
import { buildGatewayAccountList } from "./accounts";
import { GatewayQuotaAccountRow } from "./account-row";
import { describeOtherAccounts, gatewayQuotaCopy } from "./copy";
import type { GatewayQuotaView } from "./types";

/**
 * The CLIProxyAPI account inside the context-meter details: only the account serving this agent,
 * then one line counting the others and, where the surface takes presses, the All accounts
 * window. Listing every account here ran a 12-account tooltip off the screen; the window owns the
 * full list. Renders nothing when the host has neither a route nor quota to show.
 */
/** The live route's rows, else the account the agent's record last saw, else none. */
function resolveRouteRows(
  route: GatewaySessionRoute | null,
  lastServed: GatewayAccountChange | undefined,
): SessionRouteRow[] {
  if (route) return buildSessionRouteRows(route);
  return lastServed ? buildLastServedRows(lastServed) : [];
}

export function GatewayAccountSection({
  view,
  route,
  lastServed,
  serverId,
  onOpenAllAccounts,
}: {
  view: GatewayQuotaView;
  route: GatewaySessionRoute | null;
  /** The agent's newest recorded account (`gatewayAccounts`), shown when there is no live route. */
  lastServed?: GatewayAccountChange;
  serverId: string | null;
  /** Absent on surfaces that take no presses (the native wide tooltip). */
  onOpenAllAccounts?: () => void;
}) {
  const entries = useMemo(
    () => (view.kind === "ready" ? buildGatewayAccountList(view.payload, route?.account) : []),
    [route?.account, view],
  );
  const quotaSupported = view.kind === "ready" && view.payload.supported;

  if (view.kind === "loading" && !route) {
    return (
      <>
        <View style={styles.divider} />
        <Text style={styles.detail}>{gatewayQuotaCopy.loading}</Text>
      </>
    );
  }
  const routeRows = resolveRouteRows(route, lastServed);
  if (routeRows.length === 0 && entries.length === 0) return null;

  const serving = entries.filter((entry) => entry.serving);
  // With the account's own row on screen, only the switch line still adds anything.
  const shownRouteRows = serving.length > 0 ? routeRows.slice(1) : routeRows;
  const othersLine = describeOtherAccounts(entries.length - serving.length, serving.length > 0);

  return (
    <View testID="gateway-account-section">
      <View style={styles.divider} />
      <Text style={styles.title}>{gatewayQuotaCopy.title}</Text>
      {serving.map((entry) => (
        <View key={entry.key} style={styles.account}>
          <GatewayQuotaAccountRow account={entry.account} serverId={serverId} compact />
        </View>
      ))}
      {shownRouteRows.length > 0 ? (
        <View style={styles.rows}>
          {shownRouteRows.map((row) => (
            <View key={row.label} style={styles.row}>
              <Text style={styles.label}>{row.label}</Text>
              <Text style={styles.value} numberOfLines={1}>
                {row.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {othersLine || (quotaSupported && onOpenAllAccounts) ? (
        <View style={styles.footer}>
          {othersLine ? (
            <Text style={styles.detail} testID="gateway-account-others">
              {othersLine}
            </Text>
          ) : (
            <View />
          )}
          {quotaSupported && onOpenAllAccounts ? (
            <Button variant="ghost" onPress={onOpenAllAccounts} testID="gateway-open-all-accounts">
              {gatewayQuotaCopy.allAccounts}
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
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
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    lineHeight: theme.fontSize.sm * 1.4,
  },
  account: {
    marginTop: theme.spacing[2],
  },
  rows: {
    gap: theme.spacing[1],
    marginTop: theme.spacing[2],
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
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
    flexShrink: 1,
  },
}));
