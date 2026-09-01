import { Fragment } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { ProviderUsageCard } from "./card";
import type { ProviderUsage } from "./types";

export function ProviderUsageList({
  providers,
  onResetQuota,
  canResetQuota = false,
  resettingProviderId = null,
}: {
  providers: ProviderUsage[];
  onResetQuota?: (usage: ProviderUsage) => void;
  canResetQuota?: boolean;
  resettingProviderId?: string | null;
}) {
  return (
    <View style={settingsStyles.card}>
      {providers.map((usage, index) => (
        <Fragment key={usage.providerId}>
          {index > 0 ? <View style={styles.divider} /> : null}
          <ProviderUsageCard
            usage={usage}
            onResetQuota={onResetQuota}
            canResetQuota={canResetQuota}
            resetQuotaLoading={resettingProviderId === usage.providerId}
          />
        </Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  divider: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
}));
