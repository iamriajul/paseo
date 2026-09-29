import { Fragment } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { GatewayStatsSample } from "@getpaseo/protocol/messages";
import { formatAgo } from "@/provider-usage/format";
import { formatDuration, formatThroughput, gatewayStatsCopy } from "./copy";

export interface StatsTableRow {
  label: string;
  value: string;
  /** Measured by the Gateway, as opposed to derived by us. */
  measured: boolean;
}

/**
 * The timing rows, measured first and derived after, so the reader can see that
 * throughput is computed over generation time alone and not the total — which
 * is the whole reason this endpoint reports TTFT separately.
 */
export function buildStatsTableRows(sample: GatewayStatsSample): StatsTableRow[] {
  const rows: StatsTableRow[] = [
    { label: gatewayStatsCopy.firstToken, value: formatDuration(sample.ttftMs), measured: true },
    {
      label: gatewayStatsCopy.generating,
      value: formatDuration(sample.generationMs),
      measured: true,
    },
    { label: gatewayStatsCopy.total, value: formatDuration(sample.durationMs), measured: false },
    { label: gatewayStatsCopy.throughput, value: formatThroughput(sample.tps), measured: false },
  ];
  // The record's timestamp is validated on the daemon, so a missing age only
  // drops a row rather than inventing copy — same handling as provider-usage/card.
  const servedAgo = formatAgo(sample.at);
  if (servedAgo) {
    rows.push({ label: gatewayStatsCopy.ran, value: servedAgo, measured: false });
  }
  return rows;
}

// Renders the selected model's last-request stats inside the context-meter
// tooltip, beside the CLIProxyAPI quota section. Returns nothing unless the
// daemon reports a usable record, so an older Gateway build, a model that has
// not run, and a provider that is not CLIProxyAPI-routed all hide the section
// instead of showing an error.
export function GatewayStatsSection({ sample }: { sample: GatewayStatsSample | null }) {
  if (!sample) {
    return null;
  }

  const rows = buildStatsTableRows(sample);
  // Everything before the first derived row is what the Gateway measured.
  const firstDerivedIndex = rows.findIndex((row) => !row.measured);

  return (
    <>
      <View style={styles.divider} />
      <Text style={styles.title}>{gatewayStatsCopy.title}</Text>
      <View style={styles.rows}>
        {rows.map((row, index) => (
          <Fragment key={row.label}>
            {/* The rule separates the Gateway's own measurements from the rows we
                derive from them, so the split is legible without a sentence. */}
            {index === firstDerivedIndex ? <View style={styles.rule} /> : null}
            <View style={styles.row}>
              <Text style={styles.label}>{row.label}</Text>
              <Text style={styles.value}>{row.value}</Text>
            </View>
          </Fragment>
        ))}
      </View>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  divider: {
    height: 1,
    // Same token the popover draws its own outline with, so the rule reads as the
    // popover's edge. `border` is invisible here (equals the popover background).
    backgroundColor: theme.colors.borderAccent,
    marginVertical: theme.spacing[2],
    // Cancel the tooltip content's horizontal padding so the rule spans edge to edge.
    marginHorizontal: -theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    lineHeight: theme.fontSize.sm * 1.4,
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
  rule: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing[1],
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
  },
}));
