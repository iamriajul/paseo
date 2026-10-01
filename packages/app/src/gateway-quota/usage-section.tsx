import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { GatewayQuotaAccountRow } from "./account-row";
import { gatewayQuotaCopy } from "./copy";
import type { GatewayQuotaAccount } from "./types";

function AccountCard({ account, serverId }: { account: GatewayQuotaAccount; serverId: string }) {
  return (
    <View style={styles.account}>
      <GatewayQuotaAccountRow account={account} serverId={serverId} />
    </View>
  );
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
  const accounts = useMemo(() => (query.data?.supported ? query.data.accounts : []), [query.data]);
  if (!enabled || query.data?.supported === false) return null;
  if (accounts.length === 0 && !query.isLoading) return null;

  return (
    <SettingsSection title="CLIProxyAPI">
      <View style={settingsStyles.card}>
        {query.isLoading ? (
          <Text style={styles.detail}>{gatewayQuotaCopy.loading}</Text>
        ) : (
          accounts.map((account, index) => (
            <View key={`${account.provider}/${account.name ?? String(index)}`}>
              {index > 0 ? <View style={styles.divider} /> : null}
              <AccountCard account={account} serverId={serverId} />
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
  },
  divider: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
  },
}));
