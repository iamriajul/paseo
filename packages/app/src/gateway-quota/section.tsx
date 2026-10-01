import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { ScrollView } from "@/components/ui/scroll-view";
import type { Theme } from "@/styles/theme";
import { GatewayQuotaAccountRow } from "./account-row";
import { gatewayQuotaCopy } from "./copy";
import { buildGatewayQuotaSections, summarizeGatewayQuota } from "./sections";
import type { GatewayQuotaView } from "./types";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);
const chevronColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * Collapsed account count. Three rows fit the collapsed tooltip beside the
 * context, quota, and latest-request sections; more than that pushes stats
 * off-screen, which is the bug this bound fixes.
 */
const COLLAPSED_ACCOUNT_COUNT = 3;
/**
 * Expanded list height. Caps the open list so 10–20 accounts scroll inside
 * their own ScrollView instead of growing the tooltip past the viewport and
 * hiding the latest-request stats below it.
 */
const EXPANDED_LIST_MAX_HEIGHT = 280;

function SummaryLine({
  ready,
  coolingDown,
  total,
}: {
  ready: number;
  coolingDown: number;
  total: number;
}) {
  const parts = [`${total} ${total === 1 ? "account" : "accounts"}`];
  if (ready > 0) parts.push(`${ready} ${gatewayQuotaCopy.readyCount}`);
  if (coolingDown > 0) parts.push(`${coolingDown} ${gatewayQuotaCopy.coolingDownCount}`);
  return (
    <Text style={styles.summary} numberOfLines={1}>
      {parts.join(" · ")}
    </Text>
  );
}

// Renders the selected model's CLIProxyAPI quota inside the context-meter
// tooltip. Returns nothing unless the daemon reports usable accounts, so old
// CLIProxyAPI builds and transient failures hide the section instead of showing errors.
export function GatewayQuotaSection({
  view,
  serverId,
}: {
  view: GatewayQuotaView;
  serverId: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const handleToggle = useCallback(() => setExpanded((next) => !next), []);
  const sections = useMemo(
    () => (view.kind === "ready" ? buildGatewayQuotaSections(view.payload) : []),
    [view],
  );
  const payloadId = view.kind === "ready" ? view.payload.requestId : null;
  useEffect(() => {
    setExpanded(false);
  }, [payloadId]);
  if (view.kind === "loading") {
    return (
      <>
        <View style={styles.divider} />
        <Text style={styles.detail}>{gatewayQuotaCopy.loading}</Text>
      </>
    );
  }

  if (view.kind !== "ready") {
    return null;
  }

  if (sections.length === 0) {
    return null;
  }

  const summary = summarizeGatewayQuota(sections);
  const collapsible = sections.length > COLLAPSED_ACCOUNT_COUNT;
  const visible = !collapsible || expanded ? sections : sections.slice(0, COLLAPSED_ACCOUNT_COUNT);
  const rows = visible.map((section, index) => (
    <View key={section.key} style={index > 0 ? styles.accountSpacing : undefined}>
      <GatewayQuotaAccountRow account={section.account} serverId={serverId} compact />
    </View>
  ));

  return (
    <>
      <View style={styles.divider} />
      <Text style={styles.title}>{gatewayQuotaCopy.title}</Text>
      <SummaryLine ready={summary.ready} coolingDown={summary.coolingDown} total={summary.total} />
      {expanded ? (
        <ScrollView style={styles.expandedList} showsVerticalScrollIndicator>
          {rows}
        </ScrollView>
      ) : (
        rows
      )}
      {collapsible ? (
        <Toggle expanded={expanded} total={sections.length} onToggle={handleToggle} />
      ) : null}
    </>
  );
}

function Toggle({
  expanded,
  total,
  onToggle,
}: {
  expanded: boolean;
  total: number;
  onToggle: () => void;
}) {
  const Icon = expanded ? ThemedChevronUp : ThemedChevronDown;
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  return (
    <Pressable
      style={styles.toggle}
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
    >
      <Icon size={12} uniProps={chevronColor} />
      <Text style={styles.toggleLabel}>{expanded ? "Show less" : `Show all ${total}`}</Text>
    </Pressable>
  );
}
const styles = StyleSheet.create((theme) => ({
  divider: {
    height: 1,
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
  summary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
    marginTop: theme.spacing[1],
  },
  accountSpacing: {
    marginTop: theme.spacing[2],
  },
  expandedList: {
    marginTop: theme.spacing[2],
    maxHeight: EXPANDED_LIST_MAX_HEIGHT,
  },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginTop: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  toggleLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
}));
