import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useMemo } from "react";
import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { X, ArrowUp, RefreshCcw, Check, Mic, Pencil, Sparkles } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { useTranslation } from "react-i18next";
import { VolumeMeter } from "./volume-meter";
import { FOOTER_HEIGHT } from "@/constants/layout";
import type { DictationStatus } from "@/hooks/use-dictation";

interface DictationControlsProps {
  volume: number;
  duration: number;
  transcript?: string;
  isRecording: boolean;
  isProcessing: boolean;
  status: DictationStatus;
  onStart: () => void;
  onCancel: () => void;
  onAccept: () => void;
  onAcceptAndSend: () => void;
  onRetry?: () => void;
  onDiscard?: () => void;
  onPolish?: () => void;
  polishAvailable?: boolean;
  isPolishing?: boolean;
  polishError?: string | null;
  disabled?: boolean;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

export function DictationControls({
  volume,
  duration,
  isRecording,
  isProcessing,
  status,
  onStart,
  onCancel,
  onAccept,
  onAcceptAndSend,
  onRetry,
  onDiscard,
  disabled = false,
}: DictationControlsProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isFailed = status === "failed";
  const showActiveState = isRecording || isProcessing || isFailed;
  const actionsDisabled = isProcessing;
  const handleCancel = isFailed && onDiscard ? onDiscard : onCancel;

  const micButtonStyle = useMemo(
    () => [styles.micButton, disabled && styles.buttonDisabled],
    [disabled],
  );
  const timerTextStyle = useMemo(
    () => [styles.timerText, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const cancelButtonStyle = useMemo(
    () => [
      styles.actionButton,
      styles.actionButtonCancel,
      actionsDisabled && !isFailed ? styles.buttonDisabled : undefined,
    ],
    [actionsDisabled, isFailed],
  );

  if (!showActiveState) {
    return (
      <Pressable
        onPress={onStart}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={t("message.dictation.start")}
        style={micButtonStyle}
      >
        <Mic size={theme.iconSize.md} color={theme.colors.foreground} />
      </Pressable>
    );
  }

  return (
    <View style={styles.activeContainer}>
      <View style={styles.meterWrapper}>
        <VolumeMeter volume={volume} isMuted={false} isSpeaking={false} orientation="horizontal" />
      </View>
      <Text style={timerTextStyle}>{formatDuration(duration)}</Text>
      <View style={styles.actionGroup}>
        <Pressable
          onPress={handleCancel}
          disabled={actionsDisabled && !isFailed}
          accessibilityLabel={t("message.dictation.cancel")}
          style={cancelButtonStyle}
        >
          <X size={theme.iconSize.sm} color={theme.colors.foreground} />
        </Pressable>
        {actionsDisabled ? (
          <View style={styles.loadingContainer}>
            <LoadingSpinner size="small" color={theme.colors.foreground} />
          </View>
        ) : null}
        {!actionsDisabled && isFailed ? (
          <Pressable
            onPress={onRetry}
            accessibilityLabel={t("message.dictation.retry")}
            style={[styles.actionButton, styles.actionButtonConfirm]}
          >
            <RefreshCcw size={theme.iconSize.sm} color={theme.colors.surface0} />
          </Pressable>
        ) : null}
        {!actionsDisabled && !isFailed ? (
          <>
            <Pressable
              onPress={onAccept}
              accessibilityLabel={t("message.dictation.insert")}
              style={[styles.actionButton, styles.actionButtonSecondary]}
            >
              <Check size={theme.iconSize.sm} color={theme.colors.foreground} />
            </Pressable>
            <Pressable
              onPress={onAcceptAndSend}
              accessibilityLabel={t("message.dictation.insertAndSend")}
              style={[styles.actionButton, styles.actionButtonConfirm]}
            >
              <ArrowUp size={theme.iconSize.sm} color={theme.colors.surface0} />
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}

/**
 * Full-width overlay variant for the agent input footer.
 * Uses blue background with white icons.
 */
export function DictationOverlay({
  volume,
  duration,
  isRecording,
  isProcessing,
  status,
  errorText,
  onCancel,
  onAccept,
  onAcceptAndSend,
  onRetry,
  onDiscard,
  onPolish,
  polishAvailable,
  isPolishing,
  polishError,
}: Omit<DictationControlsProps, "onStart" | "disabled" | "transcript"> & { errorText?: string }) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isFailed = status === "failed";
  const isPolishingActive = isPolishing === true;
  const showActiveState = isRecording || isProcessing || isFailed || isPolishingActive;
  const showPolishAction = Boolean(polishAvailable && onPolish);
  const actionsDisabled = isProcessing || isPolishingActive;
  const handleCancel = isFailed && onDiscard ? onDiscard : onCancel;

  const containerStyle = useMemo(
    () => [overlayStyles.container, { backgroundColor: theme.colors.accent }],
    [theme.colors.accent],
  );
  const overlayCancelButtonStyle = useMemo(
    () => [
      overlayStyles.cancelButton,
      actionsDisabled && !isFailed && overlayStyles.buttonDisabled,
    ],
    [actionsDisabled, isFailed],
  );
  const overlayRetryButtonStyle = useMemo(
    () => [overlayStyles.actionButton, { backgroundColor: theme.colors.accentForeground }],
    [theme.colors.accentForeground],
  );
  const overlayConfirmButtonStyle = overlayRetryButtonStyle;

  if (!showActiveState) {
    return null;
  }

  return (
    <View style={containerStyle}>
      <Pressable
        onPress={handleCancel}
        disabled={actionsDisabled && !isFailed}
        accessibilityRole="button"
        accessibilityLabel={t("message.dictation.cancel")}
        style={overlayCancelButtonStyle}
      >
        <X size={theme.iconSize.lg} color={theme.colors.accentForeground} strokeWidth={2.5} />
      </Pressable>

      <DictationOverlayTranscript
        volume={volume}
        duration={duration}
        isFailed={isFailed}
        errorText={errorText}
        polishError={polishError}
      />

      <View style={overlayStyles.actionButtonsContainer}>
        {actionsDisabled ? (
          <View style={overlayStyles.loadingContainer}>
            <LoadingSpinner size="small" color={theme.colors.accentForeground} />
          </View>
        ) : null}
        <DictationOverlayPolishStatus isPolishingActive={isPolishingActive} isFailed={isFailed} />
        {!actionsDisabled && isFailed ? (
          <Pressable
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel={t("message.dictation.retry")}
            style={overlayRetryButtonStyle}
          >
            <RefreshCcw size={theme.iconSize.lg} color={theme.colors.accent} strokeWidth={2.5} />
          </Pressable>
        ) : null}
        {!actionsDisabled && !isFailed ? (
          <>
            <Pressable
              onPress={onAccept}
              accessibilityRole="button"
              accessibilityLabel={t("message.dictation.insert")}
              style={[overlayStyles.actionButton, OVERLAY_ACCEPT_BUTTON_BG]}
            >
              <Pencil
                size={theme.iconSize.lg}
                color={theme.colors.accentForeground}
                strokeWidth={2.5}
              />
            </Pressable>
            <DictationPolishAction
              visible={showPolishAction}
              onPolish={onPolish}
              polishLabel={t("message.dictation.polish")}
            />
            <Pressable
              onPress={onAcceptAndSend}
              accessibilityRole="button"
              accessibilityLabel={t("message.dictation.insertAndSend")}
              style={overlayConfirmButtonStyle}
            >
              <ArrowUp size={theme.iconSize.lg} color={theme.colors.accent} strokeWidth={2.5} />
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}

function DictationOverlayTranscript({
  volume,
  duration,
  isFailed,
  errorText,
  polishError,
}: {
  volume: number;
  duration: number;
  isFailed: boolean;
  errorText?: string;
  polishError?: string | null;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const timerTextStyle = useMemo(
    () => [overlayStyles.timerText, { color: theme.colors.accentForeground }],
    [theme.colors.accentForeground],
  );
  const transcriptTextStyle = useMemo(
    () => [overlayStyles.transcriptText, { color: theme.colors.accentForeground, opacity: 0.95 }],
    [theme.colors.accentForeground],
  );
  return (
    <View style={overlayStyles.centerContainer}>
      <View style={overlayStyles.meterRow}>
        <VolumeMeter
          volume={volume}
          isMuted={false}
          isSpeaking={false}
          orientation="horizontal"
          color={theme.colors.accentForeground}
        />
        <Text style={timerTextStyle}>{formatDuration(duration)}</Text>
      </View>
      {isFailed ? (
        <Text numberOfLines={2} style={transcriptTextStyle}>
          {errorText
            ? t("message.dictation.failed", { error: errorText })
            : t("message.dictation.failedRetry")}
        </Text>
      ) : null}
      {polishError && !isFailed ? (
        <Text numberOfLines={2} style={transcriptTextStyle}>
          {polishError}
        </Text>
      ) : null}
    </View>
  );
}

function DictationOverlayPolishStatus({
  isPolishingActive,
  isFailed,
}: {
  isPolishingActive: boolean;
  isFailed: boolean;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const statusTextStyle = useMemo(
    () => [overlayStyles.transcriptText, { color: theme.colors.accentForeground, opacity: 0.95 }],
    [theme.colors.accentForeground],
  );
  if (!isPolishingActive || isFailed) {
    return null;
  }
  return <Text style={statusTextStyle}>{t("message.dictation.polishing")}</Text>;
}

function DictationPolishAction({
  visible,
  onPolish,
  polishLabel,
}: {
  visible: boolean;
  onPolish?: () => void;
  polishLabel: string;
}) {
  const { theme } = useUnistyles();
  if (!visible) {
    return null;
  }
  return (
    <Pressable
      onPress={onPolish}
      accessibilityRole="button"
      accessibilityLabel={polishLabel}
      style={[overlayStyles.actionButton, OVERLAY_ACCEPT_BUTTON_BG]}
      testID="dictation-polish"
    >
      <View style={overlayStyles.sparkleBadge}>
        <Pencil size={theme.iconSize.lg} color={theme.colors.accentForeground} strokeWidth={2.5} />
        <View style={overlayStyles.sparkleOverlay}>
          <ThemedSparklesIcon size={12} uniProps={sparklesColorMapping} />
        </View>
      </View>
    </Pressable>
  );
}

const BUTTON_SIZE = 32;

const styles = StyleSheet.create((theme) => ({
  micButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  activeContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  meterWrapper: {
    width: 80,
    alignItems: "center",
    justifyContent: "center",
  },
  timerText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    fontVariant: ["tabular-nums"],
  },
  actionGroup: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  actionButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: theme.borderWidth[1],
  },
  actionButtonCancel: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  actionButtonSecondary: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  actionButtonConfirm: {
    borderColor: theme.colors.foreground,
    backgroundColor: theme.colors.foreground,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  loadingContainer: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  statusLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
}));

const OVERLAY_BUTTON_SIZE = 44;
const OVERLAY_VERTICAL_PADDING = (FOOTER_HEIGHT - OVERLAY_BUTTON_SIZE) / 2;

const overlayStyles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    borderRadius: theme.borderRadius["2xl"],
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: OVERLAY_VERTICAL_PADDING,
    height: FOOTER_HEIGHT,
  },
  cancelButton: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: "rgba(0, 0, 0, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  centerContainer: {
    flex: 1,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  meterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[4],
  },
  timerText: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    fontVariant: ["tabular-nums"],
  },
  transcriptText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
    paddingHorizontal: theme.spacing[2],
    opacity: 0.9,
  },
  actionButtonsContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionButton: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  loadingContainer: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  sparkleBadge: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  sparkleOverlay: {
    position: "absolute",
    top: -6,
    right: -8,
  },
}));

const OVERLAY_ACCEPT_BUTTON_BG = { backgroundColor: "rgba(255, 255, 255, 0.25)" };

const ThemedSparklesIcon = withUnistyles(Sparkles);
const sparklesColorMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });
