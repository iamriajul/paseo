import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Mic, MicOff, Square } from "lucide-react-native";
import { FOOTER_HEIGHT, useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useVoiceTelemetry } from "@/contexts/voice-context";
import type { VoiceInputMode } from "@/voice/voice-input-mode";
import { useKeyboardShortcutsAvailable } from "@/keyboard/availability";
import { useAppSettings } from "@/hooks/use-settings";
import { VolumeMeter } from "./volume-meter";
const OVERLAY_BUTTON_SIZE = 44;
const OVERLAY_VERTICAL_PADDING = (FOOTER_HEIGHT - OVERLAY_BUTTON_SIZE) / 2;

interface RealtimeVoiceOverlayProps {
  isMuted: boolean;
  isSwitching: boolean;
  onToggleMute: () => void;
  onStop: () => void;
  inputMode: VoiceInputMode;
  isTransmitting: boolean;
  onInputModeChange: (mode: VoiceInputMode) => void;
  onTransmitChange: (transmitting: boolean) => void;
}
export function RealtimeVoiceOverlay({
  isMuted,
  isSwitching,
  onToggleMute,
  onStop,
  inputMode,
  isTransmitting,
  onInputModeChange,
  onTransmitChange,
}: RealtimeVoiceOverlayProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const { volume, isSpeaking } = useVoiceTelemetry();
  const { updateSettings } = useAppSettings();
  const isPushToTalk = inputMode === "pushToTalk";
  const isCompact = useIsCompactFormFactor();
  const shortcutsAvailable = useKeyboardShortcutsAvailable();

  const [transmitHeld, setTransmitHeld] = useState(false);
  const holdKeyDownRef = useRef(false);
  const modeOptions = useMemo(
    () => [
      { value: "always" as const, label: t("realtimeVoice.inputMode.always") },
      { value: "pushToTalk" as const, label: t("realtimeVoice.inputMode.pushToTalk") },
    ],
    [t],
  );
  const muteButtonStyle = useMemo(
    () => [
      styles.actionButton,
      styles.muteButton,
      isMuted ? styles.muteButtonMuted : undefined,
      isPushToTalk && isTransmitting ? styles.transmitButtonActive : undefined,
      isSwitching ? styles.buttonDisabled : undefined,
    ],
    [isMuted, isSwitching, isPushToTalk, isTransmitting],
  );
  const stopButtonStyle = useMemo(
    () => [styles.actionButton, styles.stopButton, isSwitching ? styles.buttonDisabled : undefined],
    [isSwitching],
  );
  const holdHint = useMemo(() => {
    if (!isPushToTalk || isTransmitting) {
      return null;
    }
    if (isNative || isCompact) {
      return t("realtimeVoice.pushToTalk.holdMobile");
    }
    if (shortcutsAvailable) {
      return t("realtimeVoice.pushToTalk.holdDesktop", { keys: "Space" });
    }
    return t("realtimeVoice.pushToTalk.holdDesktopFallback");
  }, [isPushToTalk, isTransmitting, isCompact, shortcutsAvailable, t]);
  const startTransmit = useCallback(() => {
    if (!isPushToTalk || isSwitching) {
      return;
    }
    onTransmitChange(true);
  }, [isPushToTalk, isSwitching, onTransmitChange]);
  const transmitAccessibilityLabel = isPushToTalk
    ? t("realtimeVoice.pushToTalk.transmit")
    : resolveMuteAccessibilityLabel(isMuted, t);
  const transmitAccessibilityState = useMemo(
    () => (isPushToTalk ? { selected: transmitHeld } : undefined),
    [isPushToTalk, transmitHeld],
  );
  const stopTransmit = useCallback(() => {
    onTransmitChange(false);
  }, [onTransmitChange]);
  const handleInputModeChange = useCallback(
    (mode: VoiceInputMode) => {
      onInputModeChange(mode);
      void updateSettings({ voiceInputMode: mode }).catch((error) => {
        console.error("[RealtimeVoiceOverlay] Failed to persist voice input mode:", error);
      });
    },
    [onInputModeChange, updateSettings],
  );

  useEffect(() => {
    if (!isPushToTalk) {
      setTransmitHeld(false);
      holdKeyDownRef.current = false;
      return;
    }
    setTransmitHeld(isTransmitting);
  }, [isPushToTalk, isTransmitting]);

  useEffect(() => {
    if (!isPushToTalk || !shortcutsAvailable || isNative) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || holdKeyDownRef.current) {
        return;
      }
      if (isEditableKeyboardTarget(event.target)) {
        return;
      }
      if (!matchesHoldShortcut(event)) {
        return;
      }
      event.preventDefault();
      holdKeyDownRef.current = true;
      setTransmitHeld(true);
      onTransmitChange(true);
    };
    const handleKeyUp = () => {
      if (!holdKeyDownRef.current) {
        return;
      }
      holdKeyDownRef.current = false;
      setTransmitHeld(false);
      onTransmitChange(false);
    };
    const handleBlur = () => {
      if (!holdKeyDownRef.current) {
        return;
      }
      holdKeyDownRef.current = false;
      setTransmitHeld(false);
      onTransmitChange(false);
    };
    const matchesHoldShortcut = (event: KeyboardEvent) =>
      event.code === "Space" && !event.ctrlKey && !event.metaKey && !event.altKey;
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleBlur);
    };
  }, [isPushToTalk, shortcutsAvailable, onTransmitChange]);
  useEffect(() => {
    return () => {
      onTransmitChange(false);
    };
  }, [onTransmitChange]);

  return (
    <View style={styles.container}>
      <View style={styles.topRow}>
        <SegmentedControl
          options={modeOptions}
          value={inputMode}
          onValueChange={handleInputModeChange}
          size="xs"
        />
      </View>
      <View style={styles.bottomRow}>
        <View style={styles.meterContainer}>
          <VolumeMeter
            volume={volume}
            isMuted={isMuted}
            isSpeaking={isSpeaking}
            orientation="horizontal"
          />
          {holdHint ? (
            <View style={styles.hintContainer}>
              <Mic size={12} color={theme.colors.foregroundMuted} strokeWidth={2} />
              <Text style={styles.hintText}>{holdHint}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.actionsContainer}>
          <Pressable
            onPress={isPushToTalk ? undefined : onToggleMute}
            onPressIn={isPushToTalk ? startTransmit : undefined}
            onPressOut={isPushToTalk ? stopTransmit : undefined}
            disabled={isSwitching}
            accessibilityRole="button"
            accessibilityLabel={transmitAccessibilityLabel}
            accessibilityState={transmitAccessibilityState}
            style={muteButtonStyle}
          >
            {isMuted ? (
              <MicOff
                size={theme.iconSize.lg}
                color={theme.colors.palette.white}
                strokeWidth={2.5}
              />
            ) : (
              <Mic size={theme.iconSize.lg} color={theme.colors.foreground} strokeWidth={2.5} />
            )}
          </Pressable>

          <Pressable
            onPress={onStop}
            disabled={isSwitching}
            accessibilityRole="button"
            accessibilityLabel={t("realtimeVoice.actions.stop")}
            style={stopButtonStyle}
          >
            {isSwitching ? (
              <LoadingSpinner size="small" color={theme.colors.palette.white} />
            ) : (
              <Square
                size={theme.iconSize.lg}
                color={theme.colors.palette.white}
                fill={theme.colors.palette.white}
                strokeWidth={2.5}
              />
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function resolveMuteAccessibilityLabel(isMuted: boolean, t: (key: string) => string): string {
  return isMuted ? t("realtimeVoice.actions.unmute") : t("realtimeVoice.actions.mute");
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (typeof document === "undefined" || !(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "column",
    width: "100%",
    minHeight: FOOTER_HEIGHT,
    borderRadius: theme.borderRadius["2xl"],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: OVERLAY_VERTICAL_PADDING,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  bottomRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  meterContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  hintContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginTop: theme.spacing[1],
  },
  hintText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  actionsContainer: {
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
  muteButton: {
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  muteButtonMuted: {
    backgroundColor: theme.colors.palette.red[600],
    borderColor: theme.colors.palette.red[800],
  },
  transmitButtonActive: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  stopButton: {
    backgroundColor: theme.colors.palette.red[600],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.palette.red[800],
  },
  buttonDisabled: {
    opacity: 0.5,
  },
}));
