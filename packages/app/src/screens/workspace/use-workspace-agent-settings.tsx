import { useCallback, useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  AGENT_LABEL_RATE_LIMIT_AUTO_RESUME,
  isRateLimitAutoResumeDisabled,
} from "@getpaseo/protocol/agent-labels";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useSessionStore } from "@/stores/session-store";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

export interface ActiveAgentSettingsState {
  agentId: string;
  currentTitle: string;
}

export interface UseWorkspaceAgentSettingsInput {
  normalizedServerId: string;
  isRouteFocused?: boolean;
}

export interface UseWorkspaceAgentSettingsResult {
  activeAgentSettings: ActiveAgentSettingsState | null;
  handleOpenAgentSettings: (tab: WorkspaceTabDescriptor) => void;
  handleCloseAgentSettings: () => void;
}

export function useWorkspaceAgentSettings({
  normalizedServerId,
  isRouteFocused = true,
}: UseWorkspaceAgentSettingsInput): UseWorkspaceAgentSettingsResult {
  const [activeAgentSettings, setActiveAgentSettings] = useState<ActiveAgentSettingsState | null>(
    null,
  );

  const handleOpenAgentSettings = useCallback(
    (tab: WorkspaceTabDescriptor) => {
      if (tab.target.kind !== "agent") return;
      const { agentId } = tab.target;
      const agent =
        useSessionStore.getState().sessions[normalizedServerId]?.agents?.get(agentId) ?? null;
      const currentTitle = agent?.title ?? agentId.slice(0, 7);
      setActiveAgentSettings({ agentId, currentTitle });
    },
    [normalizedServerId],
  );

  const handleCloseAgentSettings = useCallback(() => {
    setActiveAgentSettings(null);
  }, []);

  return {
    activeAgentSettings: isRouteFocused ? activeAgentSettings : null,
    handleOpenAgentSettings,
    handleCloseAgentSettings,
  };
}

export interface WorkspaceAgentSettingsModalProps {
  activeAgentSettings: ActiveAgentSettingsState | null;
  client: DaemonClient | null;
  normalizedServerId: string;
  queryClient: QueryClient;
  onClose: () => void;
}

export function WorkspaceAgentSettingsModal({
  activeAgentSettings,
  client,
  normalizedServerId,
  queryClient,
  onClose,
}: WorkspaceAgentSettingsModalProps) {
  const { t } = useTranslation();
  const [isPending, setIsPending] = useState(false);
  const { config } = useDaemonConfig(normalizedServerId);
  const isGloballyDisabled = config?.autoResumeOnRateLimit === false;

  const agent = useSessionStore((state) =>
    activeAgentSettings
      ? (state.sessions[normalizedServerId]?.agents?.get(activeAgentSettings.agentId) ?? null)
      : null,
  );

  const isAgentAutoResumeEnabled = useMemo(() => {
    if (!agent) return true;
    return !isRateLimitAutoResumeDisabled(agent.labels);
  }, [agent]);

  const handleToggleRateLimitAutoResume = useCallback(
    async (next: boolean) => {
      if (!activeAgentSettings || !client || isGloballyDisabled || isPending) return;
      try {
        setIsPending(true);
        const currentLabels = agent?.labels ?? {};
        const nextLabels: Record<string, string> = {
          ...currentLabels,
          [AGENT_LABEL_RATE_LIMIT_AUTO_RESUME]: next ? "true" : "false",
        };
        await client.updateAgent(activeAgentSettings.agentId, { labels: nextLabels });
        void queryClient.invalidateQueries({
          queryKey: ["sidebarAgentsList", normalizedServerId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["allAgents", normalizedServerId],
        });
      } catch (error) {
        console.error("[WorkspaceAgentSettingsModal] Failed to update agent labels", error);
        Alert.alert(
          t("common.errors.unableToSave", "Unable to save"),
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setIsPending(false);
      }
    },
    [
      activeAgentSettings,
      client,
      isGloballyDisabled,
      isPending,
      agent?.labels,
      queryClient,
      normalizedServerId,
      t,
    ],
  );

  const sheetHeader = useMemo<SheetHeader>(
    () => ({
      title: t("workspace.agentSettings.title", "Agent settings"),
    }),
    [t],
  );

  if (!activeAgentSettings) {
    return null;
  }

  const switchValue = !isGloballyDisabled && isAgentAutoResumeEnabled;
  const switchDisabled = isGloballyDisabled || isPending;

  return (
    <AdaptiveModalSheet
      visible={Boolean(activeAgentSettings)}
      onClose={onClose}
      header={sheetHeader}
      testID="workspace-agent-settings-modal"
    >
      <View style={styles.body}>
        <View style={styles.agentSummary}>
          <Text style={styles.agentTitle} numberOfLines={1}>
            {agent?.title || activeAgentSettings.currentTitle}
          </Text>
          <Text style={styles.agentId} numberOfLines={1}>
            {activeAgentSettings.agentId}
          </Text>
        </View>

        <View style={styles.card} testID="agent-settings-rate-limit-card">
          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Text style={styles.rowTitle}>
                {t("workspace.agentSettings.rateLimitAutoResume", "Auto-resume on rate limits")}
              </Text>
              <Text style={[styles.rowHint, isGloballyDisabled ? styles.rowHintDisabled : null]}>
                {isGloballyDisabled
                  ? t(
                      "workspace.agentSettings.disabledGloballyHint",
                      "Disabled globally in Host Settings",
                    )
                  : t(
                      "workspace.agentSettings.rateLimitAutoResumeHint",
                      "Automatically resume this agent after API rate limit cooldown or model recovery",
                    )}
              </Text>
            </View>
            <Switch
              value={switchValue}
              onValueChange={handleToggleRateLimitAutoResume}
              disabled={switchDisabled}
              accessibilityLabel={t(
                "workspace.agentSettings.rateLimitAutoResume",
                "Auto-resume on rate limits",
              )}
              testID="agent-settings-rate-limit-switch"
            />
          </View>
        </View>

        <View style={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            style={styles.actionButton}
            onPress={onClose}
            testID="agent-settings-close-button"
          >
            {t("common.actions.close", "Close")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  agentSummary: {
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: theme.spacing[1],
  },
  agentTitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.base,
    fontWeight: "500",
    color: theme.colors.foreground,
  },
  agentId: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  card: {
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  rowContent: {
    flex: 1,
    gap: theme.spacing[1],
  },
  rowTitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.base,
    fontWeight: "500",
    color: theme.colors.foreground,
  },
  rowHint: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  rowHintDisabled: {
    color: theme.colors.palette.amber[500],
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  actionButton: {
    minWidth: 80,
  },
}));
