import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ProviderUsageWindowBar } from "@/provider-usage/window-bar";
import { gatewayQuotaCopy } from "./copy";
import { buildGatewayQuotaSections } from "./sections";
import type { GatewayQuotaView } from "./types";

// Renders the selected model's CLIProxyAPI quota inside the context-meter
// tooltip. Returns nothing unless the daemon reports usable accounts, so old
// CLIProxyAPI builds and transient failures hide the section instead of showing errors.
export function GatewayQuotaSection({ view }: { view: GatewayQuotaView }) {
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

  const sections = buildGatewayQuotaSections(view.payload);
  if (sections.length === 0) {
    return null;
  }

  return (
    <>
      <View style={styles.divider} />
      <Text style={styles.title}>{gatewayQuotaCopy.title}</Text>
      {sections.map((section) => (
        <View key={section.key} style={styles.account}>
          <Text style={styles.heading}>{section.heading}</Text>
          {section.inCooldown ? (
            <Text style={styles.cooldown}>{gatewayQuotaCopy.coolingDown}</Text>
          ) : null}
          {section.windows.map((window) => (
            <ProviderUsageWindowBar key={window.id} window={window} />
          ))}
        </View>
      ))}
    </>
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
  heading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
    marginTop: theme.spacing[1],
  },
  cooldown: {
    color: theme.colors.palette.amber[500],
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  account: {
    marginTop: theme.spacing[1],
  },
}));
