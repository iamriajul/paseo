import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { ModelProviderGlyph } from "@/components/model-browser";
import { ProviderUsageWindowBar } from "@/provider-usage/window-bar";
import { settingsStyles } from "@/styles/settings";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { ICON_SIZE } from "@/styles/theme";
import { gatewayQuotaCopy } from "./copy";
import { buildGatewayQuotaSections } from "./sections";

function accountIconId(provider: string): string {
  const key = provider.toLowerCase();
  if (key.includes("anthropic") || key === "claude") return "claude";
  if (key.includes("openai") || key === "codex") return "codex";
  if (key.includes("copilot") || key.includes("github")) return "copilot";
  if (key.includes("opencode")) return "opencode";
  if (key.includes("minimax")) return "minimax";
  if (key === "omp" || key.includes("muse")) return "omp";
  return key;
}

export function CliproxyapiUsageSection({ serverId }: { serverId: string }) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const enabled = useHostFeature(serverId, "cliproxyapiQuota") && Boolean(client && isConnected);
  const query = useFetchQuery({
    queryKey: ["cliproxyapiQuota", serverId],
    queryFn: () => {
      if (!client) throw new Error(gatewayQuotaCopy.clientUnavailable);
      return client.listCliproxyapiQuota();
    },
    enabled,
    retry: false,
    dataShape: "value",
    staleTimeMs: 60_000,
  });

  const sections = useMemo(
    () => (query.data?.supported ? buildGatewayQuotaSections(query.data) : []),
    [query.data],
  );
  if (!enabled || query.data?.supported === false) return null;
  if (sections.length === 0 && !query.isLoading) return null;

  return (
    <SettingsSection title="CLIProxyAPI">
      <View style={settingsStyles.card}>
        {query.isLoading ? (
          <Text style={styles.detail}>{gatewayQuotaCopy.loading}</Text>
        ) : (
          sections.map((section) => (
            <View key={section.key} style={styles.account}>
              <View style={styles.headingRow}>
                <ModelProviderGlyph
                  provider={accountIconId(section.heading.split(" · ")[0] ?? "")}
                  serverId={serverId}
                  size={ICON_SIZE.sm}
                />
                <Text style={styles.heading}>{section.heading}</Text>
              </View>
              {section.inCooldown ? (
                <Text style={styles.cooldown}>{gatewayQuotaCopy.coolingDown}</Text>
              ) : null}
              {section.windows.map((window) => (
                <ProviderUsageWindowBar key={window.id} window={window} />
              ))}
            </View>
          ))
        )}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  account: {
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  headingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  cooldown: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
  },
}));
