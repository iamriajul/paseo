import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { useGatewaySessionRoute } from "@/gateway-session-route/use-gateway-session-route";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildGatewayAccountList, summarizeGatewayAccounts } from "./accounts";
import { GatewayQuotaAccountRow } from "./account-row";
import { describeAccountSummary, gatewayQuotaCopy } from "./copy";
import { buildGatewayModelOptions } from "./gateway-models";
import type { GatewayQuotaView } from "./types";
import { useGatewayQuota } from "./use-gateway-quota";

const HEADER = { title: gatewayQuotaCopy.allAccountsTitle };
/** Past this many models the picker gets a search field. */
const SEARCHABLE_MODEL_COUNT = 8;

/**
 * Every CLIProxyAPI account that can serve a model, opened from the context meter. The model
 * defaults to the agent's and can be any model the gateway serves, without creating an agent.
 * Built like Session insights: a dialog on desktop, a sheet on the phone.
 */
export function GatewayAllAccountsDialog({
  serverId,
  agentId,
  provider,
  model,
  visible,
  onClose,
}: {
  serverId: string;
  agentId: string;
  provider: string;
  model: string;
  visible: boolean;
  onClose: () => void;
}): ReactElement {
  const [picked, setPicked] = useState(model);
  const { entries: snapshot } = useProvidersSnapshot(serverId, { enabled: visible });
  const catalog = snapshot?.find((entry) => entry.provider === provider)?.models;
  const modelOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      buildGatewayModelOptions(catalog, model).map((option) => ({
        id: option.id,
        value: option.id,
        label: option.label,
        description: option.label !== option.id ? option.id : undefined,
        testID: `gateway-accounts-model-${option.id}`,
      })),
    [catalog, model],
  );
  const selectedDisplay = useMemo(() => {
    const option = modelOptions.find((entry) => entry.value === picked);
    return { label: option?.label ?? picked };
  }, [modelOptions, picked]);
  const handleModelChange = useCallback((value: string) => setPicked(value), []);
  const { view } = useGatewayQuota(serverId, provider, picked, { enabled: visible });
  const route = useGatewaySessionRoute(serverId, agentId);
  // The badge means "this agent's requests go here", which only holds for the agent's model.
  const serving = picked === model ? route?.account : null;

  return (
    <AdaptiveModalSheet
      header={HEADER}
      visible={visible}
      onClose={onClose}
      desktopMaxWidth={560}
      testID="gateway-all-accounts"
    >
      <View style={styles.body}>
        <SelectField
          label={gatewayQuotaCopy.model}
          value={picked}
          selectedDisplay={selectedDisplay}
          options={modelOptions}
          onChange={handleModelChange}
          placeholder={gatewayQuotaCopy.model}
          emptyText={gatewayQuotaCopy.noAccounts}
          searchable={modelOptions.length > SEARCHABLE_MODEL_COUNT}
          searchPlaceholder={gatewayQuotaCopy.searchModels}
          title={gatewayQuotaCopy.model}
          testID="gateway-accounts-model"
          triggerTestID="gateway-accounts-model-trigger"
        />
        <AccountList view={view} serverId={serverId} serving={serving} />
      </View>
    </AdaptiveModalSheet>
  );
}

function AccountList({
  view,
  serverId,
  serving,
}: {
  view: GatewayQuotaView;
  serverId: string;
  serving: Parameters<typeof buildGatewayAccountList>[1];
}): ReactElement {
  const entries = useMemo(
    () => (view.kind === "ready" ? buildGatewayAccountList(view.payload, serving) : []),
    [serving, view],
  );
  if (view.kind === "loading") return <Text style={styles.note}>{gatewayQuotaCopy.loading}</Text>;
  if (view.kind === "error") return <Text style={styles.note}>{view.message}</Text>;
  if (!view.payload.supported)
    return <Text style={styles.note}>{gatewayQuotaCopy.unsupported}</Text>;
  if (entries.length === 0) return <Text style={styles.note}>{gatewayQuotaCopy.noAccounts}</Text>;

  const summary = summarizeGatewayAccounts(entries);
  return (
    <View style={styles.list}>
      <Text style={styles.summary} testID="gateway-accounts-summary">
        {describeAccountSummary(summary)}
      </Text>
      <View style={styles.card}>
        {entries.map((entry, index) => (
          <View
            key={entry.key}
            style={index > 0 ? [styles.row, styles.rowDivider] : styles.row}
            testID="gateway-accounts-row"
          >
            <GatewayQuotaAccountRow
              account={entry.account}
              serverId={serverId}
              showUsable
              serving={entry.serving}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
  },
  list: {
    gap: theme.spacing[2],
  },
  summary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  card: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  row: {
    padding: theme.spacing[3],
  },
  rowDivider: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
