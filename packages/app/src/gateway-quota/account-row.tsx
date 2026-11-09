// Shared CLIProxyAPI account row. Single source for the identity block
// (glyph + provider / name / plan + cooldown) and the window bars, so the
// context-meter details, the All accounts window and the Usage settings tab cannot drift apart.
// `compact` shrinks the icon well for the 320px tooltip; settings uses the roomy variant.
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ModelProviderGlyph } from "@/components/model-browser";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatResetLabel, formatResetTime } from "@/usage/format";
import { UsageWindowBar } from "@/usage/window-bar";
import { ICON_SIZE } from "@/styles/theme";
import { gatewayAccountAvailability, type GatewayAccountAvailability } from "./accounts";
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

/** Gateway rows are never pinnable; UsageWindowBar still requires the callback. */
const noopPinToggle = (): void => {};

function gatewayAccountIconId(provider: string): string {
  return ACCOUNT_ICON_IDS[provider.toLowerCase()] ?? provider.toLowerCase();
}

/** "Usable now", "Cooling down until 3:00 PM", "Quota used up · back Fri 9:00 AM". */
export function describeGatewayAccountAvailability(
  availability: GatewayAccountAvailability,
  now = Date.now(),
): string {
  if (availability.kind === "usable") return gatewayQuotaCopy.usable;
  const until = formatResetTime(availability.until, now);
  if (availability.reason === "cooldown") {
    return until ? `${gatewayQuotaCopy.coolingDown} until ${until}` : gatewayQuotaCopy.coolingDown;
  }
  return until ? `${gatewayQuotaCopy.usedUp} · back ${until}` : gatewayQuotaCopy.usedUp;
}

function AccountStatus({
  availability,
  serving,
  showUsable,
}: {
  availability: GatewayAccountAvailability;
  serving: boolean;
  showUsable: boolean;
}) {
  const showStatus = showUsable || availability.kind === "blocked";
  if (!serving && !showStatus) return null;
  return (
    <View style={styles.trailing}>
      {serving ? <StatusBadge label={gatewayQuotaCopy.servingBadge} size="xs" /> : null}
      {showStatus ? (
        <Text
          style={availability.kind === "usable" ? styles.usable : styles.blocked}
          testID="gateway-account-availability"
        >
          {describeGatewayAccountAvailability(availability)}
        </Text>
      ) : null}
    </View>
  );
}

export function GatewayQuotaAccountRow({
  account,
  serverId,
  compact = false,
  showUsable = false,
  serving = false,
}: {
  account: GatewayQuotaAccount;
  serverId: string | null;
  compact?: boolean;
  /** Say "Usable now" too; otherwise the row names only a block. */
  showUsable?: boolean;
  /** Badge the row as the account serving this agent. */
  serving?: boolean;
}) {
  const availability = gatewayAccountAvailability(account);
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
        <AccountStatus availability={availability} serving={serving} showUsable={showUsable} />
      </View>
      {windows.length > 0 ? (
        <View style={[styles.windows, compact && styles.windowsCompact]}>
          {windows.map((window) => (
            <UsageWindowBar
              key={window.id}
              window={window}
              displayAs="used"
              pinnable={false}
              pinned={false}
              onTogglePin={noopPinToggle}
              pinLabel=""
              pinTestID={`gateway-quota-pin-${window.id}`}
            />
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
  trailing: {
    alignItems: "flex-end",
    gap: theme.spacing[1],
    flexShrink: 1,
    maxWidth: "50%",
  },
  blocked: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
    textAlign: "right",
  },
  usable: {
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.sm,
    textAlign: "right",
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
