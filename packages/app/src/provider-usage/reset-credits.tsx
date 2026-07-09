import { RotateCcw } from "lucide-react-native";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { providerUsageCopy } from "./copy";
import { formatDate } from "./format";
import type { ProviderUsageResetCredit } from "./types";

function pluralizeReset(count: number): string {
  return count === 1 ? "1 reset" : `${count} resets`;
}

function formatExpiry(iso: string | null | undefined): string {
  const date = formatDate(iso);
  return date ? `Expires ${date}` : "No expiry date";
}

function resetCreditLabel(credit: ProviderUsageResetCredit, index: number): string {
  return credit.label || `Reset ${index + 1}`;
}

export function ProviderUsageResetCredits({
  resetCredits,
  resetCreditCount = resetCredits.length,
  onResetQuota,
  resetQuotaLoading = false,
}: {
  resetCredits: ProviderUsageResetCredit[];
  resetCreditCount?: number;
  onResetQuota?: () => void;
  resetQuotaLoading?: boolean;
}) {
  if (resetCreditCount === 0) return null;

  return (
    <View style={styles.container}>
      <View style={styles.summaryRow}>
        <Text style={styles.label} numberOfLines={1}>
          Available resets
        </Text>
        <View style={styles.summaryActions}>
          <Text style={styles.value} numberOfLines={1}>
            {pluralizeReset(resetCreditCount)}
          </Text>
          {onResetQuota ? (
            <Button
              variant="outline"
              size="xs"
              leftIcon={RotateCcw}
              loading={resetQuotaLoading}
              onPress={onResetQuota}
              accessibilityLabel={providerUsageCopy.resetQuota}
            >
              {providerUsageCopy.resetQuota}
            </Button>
          ) : null}
        </View>
      </View>
      {resetCredits.length > 0 ? (
        <View style={styles.rows}>
          {resetCredits.map((credit, index) => (
            <View key={credit.id} style={styles.creditRow}>
              <Text style={styles.creditLabel} numberOfLines={1}>
                {resetCreditLabel(credit, index)}
              </Text>
              <Text style={styles.creditValue} numberOfLines={1}>
                {formatExpiry(credit.expiresAt)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[1],
  },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  label: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  value: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  summaryActions: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rows: {
    gap: theme.spacing[1],
  },
  creditRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  creditLabel: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  creditValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
}));
