// Shared CLIProxyAPI account row. Single source for the identity block
// (glyph + provider / name / plan + cooldown) and the window bars, so the
// context-meter tooltip and the Usage settings tab cannot drift apart.
// `compact` shrinks the icon well for the 320px tooltip; settings uses the roomy variant.
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ModelProviderGlyph } from "@/components/model-browser";
import { formatResetLabel } from "@/provider-usage/format";
import { ProviderUsageWindowBar } from "@/provider-usage/window-bar";
import { ICON_SIZE } from "@/styles/theme";
import { gatewayQuotaCopy } from "./copy";
import type { GatewayQuotaAccount } from "./types";

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

function gatewayAccountIconId(provider: string): string {
  return ACCOUNT_ICON_IDS[provider.toLowerCase()] ?? provider.toLowerCase();
}

export function GatewayQuotaAccountRow({
  account,
  serverId,
  compact = false,
}: {
  account: GatewayQuotaAccount;
  serverId: string | null;
  compact?: boolean;
}) {
  const title = account.providerName || account.provider;
  const soonestLabel = formatResetLabel(account.resetCredits?.[0]?.expiresAt);
  const windows = account.windows.map((window, windowIndex) => ({
    id: `${account.provider}/${account.name ?? account.provider}/${window.name}/${windowIndex}`,
    label: window.name,
    usedPct: window.usedPct ?? null,
    resetsAt: window.resetsAt ?? null,
  }));
  return (
    <View style={styles.container}>
      <View style={styles.identity}>
        <View style={[styles.iconWell, compact && styles.iconWellCompact]}>
          <ModelProviderGlyph
            provider={gatewayAccountIconId(account.provider)}
            serverId={serverId}
            size={compact ? ICON_SIZE.xs : ICON_SIZE.sm}
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
            <Text style={styles.plan} numberOfLines={1}>
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
        <View style={[styles.windows, compact && styles.windowsCompact]}>
          {windows.map((window) => (
            <ProviderUsageWindowBar key={window.id} window={window} />
          ))}
        </View>
      ) : null}
      {account.resetCredits && account.resetCredits.length > 0 ? (
        <Text style={[styles.credits, compact && styles.creditsCompact]} numberOfLines={1}>
          <Text style={styles.planLabel}>Reset credits: </Text>
          {account.resetCredits.length}
          {soonestLabel ? ` · soonest ${soonestLabel}` : ""}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
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
  iconWellCompact: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.md,
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
    flexShrink: 0,
  },
  windows: {
    gap: theme.spacing[2],
    // Indent under the text column, past the 32px well + 8px gap.
    paddingLeft: 40,
  },
  windowsCompact: {
    // Same rail rule for the 24px well + 8px gap.
    paddingLeft: 32,
  },
  credits: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingLeft: 40,
  },
  creditsCompact: {
    paddingLeft: 32,
  },
}));
