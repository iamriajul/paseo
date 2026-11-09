import { memo, useCallback, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { Play, ShieldOff } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  buildClosedPermissionGoAheadPrompt,
  type PromptCacheClosedPermission,
} from "@getpaseo/protocol/agent-cache-warm";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";

const ThemedShieldOff = withUnistyles(ShieldOff);
const ThemedPlay = withUnistyles(Play);

const warningIconColorMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });

const PlayIcon = ({ color, size }: { color: string; size: number }) => (
  <ThemedPlay size={size} color={color} />
);

/** The permission warm-up closed while the user was away, until their next message clears it. */
export function useClosedPermission(
  serverId: string,
  agentId: string,
): PromptCacheClosedPermission | null {
  return useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents?.get(agentId) ?? session?.agentDetails?.get(agentId);
    return agent?.promptCache?.permissionClosed ?? null;
  });
}

export interface ClosedPermissionBannerProps {
  serverId: string;
  agentId: string;
  closed: PromptCacheClosedPermission;
  readOnly?: boolean;
  onToastError?: (message: string) => void;
}

/**
 * Warm-up denied a pending permission at its deadline so the session could stay warm. The agent
 * stopped and waits; "Run it now" gives it the go-ahead the user could not give while away.
 */
export const ClosedPermissionBanner = memo(function ClosedPermissionBanner({
  serverId,
  agentId,
  closed,
  readOnly,
  onToastError,
}: ClosedPermissionBannerProps): ReactElement {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const [isSending, setIsSending] = useState(false);

  const handleRunNow = useCallback(async () => {
    if (!client || !isConnected || isSending) return;
    setIsSending(true);
    try {
      // The daemon clears the banner when this message arrives.
      await client.sendAgentMessage(agentId, buildClosedPermissionGoAheadPrompt(closed));
    } catch (error) {
      onToastError?.(toErrorMessage(error));
      setIsSending(false);
    }
  }, [client, isConnected, isSending, agentId, closed, onToastError]);

  return (
    <View style={styles.container} testID="closed-permission-banner">
      <View style={styles.iconContainer}>
        <ThemedShieldOff size={20} uniProps={warningIconColorMapping} />
      </View>
      <View style={styles.content}>
        <Text style={styles.title}>Permission closed while you were away</Text>
        <Text style={styles.message}>
          The session was kept warm, so the request was declined and the agent stopped.
        </Text>
        <Text style={styles.command} numberOfLines={3} testID="closed-permission-command">
          {closed.command ? `${closed.tool}: ${closed.command}` : closed.tool}
        </Text>
      </View>
      {readOnly ? null : (
        <View style={styles.actions}>
          <Button
            size="sm"
            variant="secondary"
            testID="closed-permission-run-now"
            onPress={handleRunNow}
            loading={isSending}
            disabled={!client || !isConnected}
            leftIcon={PlayIcon}
          >
            Run it now
          </Button>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.statusWarning,
    borderRadius: theme.borderRadius.xl,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    marginVertical: theme.spacing[2],
    flexDirection: {
      xs: "column",
      sm: "row",
    },
    alignItems: {
      xs: "stretch",
      sm: "center",
    },
    gap: theme.spacing[3],
  },
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusWarningTint,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    alignSelf: {
      xs: "flex-start",
      sm: "center",
    },
  },
  content: {
    flex: 1,
    gap: theme.spacing[1],
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  message: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  command: {
    fontSize: theme.fontSize.code,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
    justifyContent: {
      xs: "flex-end",
      sm: "flex-start",
    },
  },
}));
