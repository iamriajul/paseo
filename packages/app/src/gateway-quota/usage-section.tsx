import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { ModelProviderGlyph } from "@/components/model-browser";
import { formatResetLabel } from "@/provider-usage/format";
import { ProviderUsageWindowBar } from "@/provider-usage/window-bar";
import { settingsStyles } from "@/styles/settings";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { ICON_SIZE } from "@/styles/theme";
import { gatewayQuotaCopy } from "./copy";
import type { GatewayQuotaAccount, GatewayQuotaWindow } from "./types";

const ACCOUNT_ICON_IDS: Record<string, string> = {
  anthropic: "claude",
  claude: "claude",
  openai: "codex",
  codex: "codex",
  copilot: "copilot",
  github: "copilot",
  opencode: "opencode",
  gemini: "gemini",
  google: "gemini",
  vertex: "gemini",
  antigravity: "gemini",
  kimi: "kimi",
  moonshot: "kimi",
  minimax: "minimax",
  omp: "omp",
  muse: "omp",
  xai: "xai",
  grok: "xai",
  zai: "zai",
  zhipu: "zai",
};

function accountIconId(provider: string): string {
  return ACCOUNT_ICON_IDS[provider.toLowerCase()] ?? provider.toLowerCase();
}

function windowBar(account: GatewayQuotaAccount, window: GatewayQuotaWindow) {
  return {
    id: `${account.provider}/${account.name ?? account.provider}/${window.name}`,
    label: window.name,
    usedPct: window.usedPct ?? null,
    resetsAt: window.resetsAt ?? null,
  };
}

function AccountCard({ account, serverId }: { account: GatewayQuotaAccount; serverId: string }) {
  const title = account.providerName || account.provider;
  const soonestLabel = formatResetLabel(account.resetCredits?.[0]?.expiresAt);
  const windows = account.windows.map((window) => windowBar(account, window));
  return (
    <View style={styles.account}>
      <View style={styles.identity}>
        <View style={styles.iconWell}>
          <ModelProviderGlyph
            provider={accountIconId(account.provider)}
            serverId={serverId}
            size={ICON_SIZE.sm}
          />
        </View>
        <View style={styles.identityText}>
          <Text style={styles.providerName} numberOfLines={1}>
            {title}
          </Text>
          {account.name ? (
            <Text style={styles.accountName} numberOfLines={1}>
              {account.name}
            </Text>
          ) : null}
          {account.plan ? (
            <Text style={styles.plan}>
              <Text style={styles.planLabel}>Plan: </Text>
              {account.plan}
            </Text>
          ) : null}
        </View>
        {account.inCooldown ? (
          <Text style={styles.cooldown}>{gatewayQuotaCopy.coolingDown}</Text>
        ) : null}
      </View>
      {windows.length > 0 ? (
        <View style={styles.windows}>
          {windows.map((window) => (
            <ProviderUsageWindowBar key={window.id} window={window} />
          ))}
        </View>
      ) : null}
      {account.resetCredits && account.resetCredits.length > 0 ? (
        <Text style={styles.credits}>
          <Text style={styles.planLabel}>Reset credits: </Text>
          {account.resetCredits.length}
          {soonestLabel ? ` · soonest ${soonestLabel}` : ""}
        </Text>
      ) : null}
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
            <AccountCard
              key={`${account.provider}/${account.name ?? String(index)}`}
              account={account}
              serverId={serverId}
            />
          ))
        )}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  account: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  identity: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  iconWell: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
  },
  identityText: {
    flex: 1,
    gap: 2,
  },
  providerName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  accountName: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  plan: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  planLabel: {
    fontWeight: "600",
  },
  cooldown: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
  },
  windows: {
    gap: theme.spacing[2],
    paddingLeft: 40,
  },
  credits: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingLeft: 40,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
  },
}));
