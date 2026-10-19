import { memo, useCallback, useState, type ReactElement } from "react";
import { View, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { CalendarClock, Play, XCircle } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentRateLimitCooldownPayload } from "@getpaseo/protocol/messages";
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

export interface RateLimitCooldownBannerProps {
  serverId: string;
  agentId: string;
  cooldown: AgentRateLimitCooldownPayload;
  onToastError?: (message: string) => void;
}

export const RateLimitCooldownBanner = memo(function RateLimitCooldownBanner({
  serverId,
  agentId,
  cooldown,
  onToastError,
}: RateLimitCooldownBannerProps): ReactElement | null {
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

  const handleResumeNow = useCallback(async () => {
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

  return (
    <View style={styles.container} testID="rate-limit-cooldown-banner">
      <View style={styles.iconContainer}>
        <ThemedCalendarClock size={20} uniProps={warningIconColorMapping} />
      </View>
      <View style={styles.content}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>{t("rateLimitCooldown.title")}</Text>
          {consecutiveResumes !== undefined && consecutiveResumes > 0 ? (
            <Text style={styles.retryBadge}>
              {t("rateLimitCooldown.attemptBadge", { current: consecutiveResumes + 1, max: 10 })}
            </Text>
          ) : null}
        </View>
        <Text style={styles.message}>
          {t("rateLimitCooldown.bannerMessage", {
            countdown: countdownText,
            time: formattedUtc,
          })}
        </Text>
      </View>
      {supportsControls ? (
        <View style={styles.actions}>
          <Button
            size="sm"
            variant="secondary"
            testID="rate-limit-cooldown-resume-button"
            onPress={handleResumeNow}
            loading={isResuming}
            disabled={!isConnected || isCanceling}
            leftIcon={PlayIcon}
          >
            {t("rateLimitCooldown.resumeNow")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            testID="rate-limit-cooldown-cancel-button"
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
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  retryBadge: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusWarning,
    backgroundColor: theme.colors.statusWarningTint,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.md,
  },
  message: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
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
