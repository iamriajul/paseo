import { memo, useCallback, useState, type ReactElement } from "react";
import { View, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { CalendarClock, Play, XCircle } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentRateLimitCooldownPayload } from "@getpaseo/protocol/messages";
import { ComposerTrackPill } from "@/composer/tracks";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";
import { useRateLimitCooldown } from "./use-rate-limit-cooldown";

const ThemedCalendarClock = withUnistyles(CalendarClock);
const ThemedPlay = withUnistyles(Play);
const ThemedXCircle = withUnistyles(XCircle);

const warningIconColorMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });

const PlayIcon = ({ color, size }: { color: string; size: number }) => (
  <ThemedPlay size={size} color={color} />
);

const CancelIcon = ({ color, size }: { color: string; size: number }) => (
  <ThemedXCircle size={size} color={color} />
);

export interface RateLimitCooldownPillProps {
  serverId: string;
  agentId: string;
  cooldown: AgentRateLimitCooldownPayload;
  onToastError?: (message: string) => void;
}

const PillIcon = memo(function PillIcon(): ReactElement {
  return <ThemedCalendarClock size={14} uniProps={warningIconColorMapping} />;
});

export const RateLimitCooldownPill = memo(function RateLimitCooldownPill({
  serverId,
  agentId,
  cooldown,
  onToastError,
}: RateLimitCooldownPillProps): ReactElement | null {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supportsControls = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.rateLimitCooldownControls === true,
  );
  const { isActive, countdownText, formattedUtc, consecutiveResumes } =
    useRateLimitCooldown(cooldown);

  const [isResuming, setIsResuming] = useState(false);
  const [isCanceling, setIsCanceling] = useState(false);

  const handleResume = useCallback(async () => {
    if (!client || !isConnected || isResuming || isCanceling) return;
    setIsResuming(true);
    try {
      await client.resumeRateLimitCooldown(agentId);
    } catch (error) {
      onToastError?.(toErrorMessage(error));
      setIsResuming(false);
    }
  }, [client, isConnected, isResuming, isCanceling, agentId, onToastError]);

  const handleCancel = useCallback(async () => {
    if (!client || !isConnected || isCanceling || isResuming) return;
    setIsCanceling(true);
    try {
      await client.cancelRateLimitCooldown(agentId);
    } catch (error) {
      onToastError?.(toErrorMessage(error));
      setIsCanceling(false);
    }
  }, [client, isConnected, isCanceling, isResuming, agentId, onToastError]);

  if (!isActive) {
    return null;
  }

  const segments = [
    {
      bucket: null,
      text: t("rateLimitCooldown.pillLabel", { countdown: countdownText }),
    },
  ];

  return (
    <ComposerTrackPill
      testID="rate-limit-cooldown-pill"
      segments={segments}
      icon={PillIcon}
      accessibilityLabel={t("rateLimitCooldown.pillLabel", { countdown: countdownText })}
      panelTitle={t("rateLimitCooldown.title")}
    >
      <View style={styles.panelContent}>
        <View style={styles.detailRow}>
          <Text style={styles.detailTitle}>{t("rateLimitCooldown.title")}</Text>
          <Text style={styles.detailTime}>
            {t("rateLimitCooldown.resumesAt", { time: formattedUtc })}
          </Text>
          {consecutiveResumes !== undefined && consecutiveResumes > 0 ? (
            <Text style={styles.consecutiveText}>
              {t("rateLimitCooldown.attemptBadge", { current: consecutiveResumes + 1, max: 10 })}
            </Text>
          ) : null}
        </View>
        {supportsControls ? (
          <View style={styles.actionsRow}>
            <Button
              size="sm"
              variant="secondary"
              testID="rate-limit-pill-resume-button"
              onPress={handleResume}
              loading={isResuming}
              disabled={!isConnected || isCanceling}
              leftIcon={PlayIcon}
            >
              {t("rateLimitCooldown.resumeNow")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              testID="rate-limit-pill-cancel-button"
              onPress={handleCancel}
              loading={isCanceling}
              disabled={!isConnected || isResuming}
              leftIcon={CancelIcon}
            >
              {t("rateLimitCooldown.cancel")}
            </Button>
          </View>
        ) : null}
      </View>
    </ComposerTrackPill>
  );
});

const styles = StyleSheet.create((theme: Theme) => ({
  panelContent: {
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  detailRow: {
    gap: theme.spacing[1],
  },
  detailTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  detailTime: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  consecutiveText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusWarning,
  },
  actionsRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
    justifyContent: "flex-end",
  },
}));
