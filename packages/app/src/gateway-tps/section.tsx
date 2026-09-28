import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { GatewayTpsSample } from "@getpaseo/protocol/messages";
import { formatAgo } from "@/provider-usage/format";
import { gatewayTpsCopy } from "./copy";

// Renders the selected model's generation throughput inside the context-meter
// tooltip, beside the CLIProxyAPI quota section. Returns nothing unless the
// daemon reports a usable record, so an older Gateway build, a model that has
// not run, and a provider that is not CLIProxyAPI-routed all hide the section
// instead of showing an error.

/** The three informative lines, as plain text, in the order the tooltip shows them. */
export function buildTpsDetailLines(sample: GatewayTpsSample): string[] {
  const servedAgo = formatAgo(sample.at);
  return [
    gatewayTpsCopy.title,
    gatewayTpsCopy.rate(sample.tps),
    gatewayTpsCopy.detail(sample.outputTokens, sample.generationMs),
    // The record's timestamp is validated on the daemon, so a missing age only
    // drops a line rather than inventing copy — same handling as provider-usage/card.
    ...(servedAgo ? [servedAgo] : []),
  ];
}

export function GatewayTpsSection({ sample }: { sample: GatewayTpsSample | null }) {
  if (!sample) {
    return null;
  }

  const [, rate, detail, servedAgo] = buildTpsDetailLines(sample);

  return (
    <>
      <View style={styles.divider} />
      <Text style={styles.title}>{gatewayTpsCopy.title}</Text>
      <Text style={styles.rate}>{rate}</Text>
      <Text style={styles.detail}>{detail}</Text>
      {servedAgo ? <Text style={styles.detail}>{servedAgo}</Text> : null}
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
  rate: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
}));
