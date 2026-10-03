import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Sparkles, Square, Volume2 } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import {
  createOnDeviceReadAloudEngine,
  resetOnDeviceReadAloudVoiceCache,
} from "@/voice/read-aloud-engine";
import { useReadAloudPlayer } from "@/voice/use-read-aloud-player";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export type ReadAloudKind = "raw" | "rewritten";

interface ReadAloudButtonProps {
  text: string;
  kind: ReadAloudKind;
  client?: DaemonClient | null;
  supportsRewrite: boolean;
  visible?: boolean;
  testID?: string;
}

interface ReadAloudButtonGroupProps {
  text: string;
  client?: DaemonClient | null;
  supportsRewrite: boolean;
  visible?: boolean;
  testID?: string;
}

const ThemedVolumeIcon = withUnistyles(Volume2);
const ThemedSquareIcon = withUnistyles(Square);
const ThemedSparklesIcon = withUnistyles(Sparkles);

const volumeColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const activeColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const sparklesColorMapping = (theme: Theme) => ({ color: theme.colors.accent });

const READ_ALOUD_REWRITE_TIMEOUT_MS = 30_000;

function useReadAloudEngine() {
  return useMemo(createOnDeviceReadAloudEngine, []);
}

function ReadAloudButtonIcon({ active, kind }: { active: boolean; kind: ReadAloudKind }) {
  if (active) {
    return <ThemedSquareIcon size={13} uniProps={activeColorMapping} />;
  }
  if (kind === "rewritten") {
    return (
      <View style={readAloudButtonStylesheet.sparkleBadge}>
        <ThemedVolumeIcon size={13} uniProps={volumeColorMapping} />
        <View style={readAloudButtonStylesheet.sparkleOverlay}>
          <ThemedSparklesIcon size={8} uniProps={sparklesColorMapping} />
        </View>
      </View>
    );
  }
  return <ThemedVolumeIcon size={13} uniProps={volumeColorMapping} />;
}

export const ReadAloudButton = memo(function ReadAloudButton({
  text,
  kind,
  client,
  supportsRewrite,
  visible = true,
  testID,
}: ReadAloudButtonProps) {
  const { t } = useTranslation();
  const engine = useReadAloudEngine();
  const { player, snapshot } = useReadAloudPlayer(engine);
  const [rewriteError, setRewriteError] = useState<string | null>(null);
  const [isRewriting, setIsRewriting] = useState(false);
  const requestRef = useRef(0);

  const buttonKey = useMemo(() => `${kind}:${text}`, [kind, text]);
  const isActive = snapshot.activeKey === buttonKey && snapshot.state.status === "speaking";
  const showControls = shouldShowReadAloudControls({
    visible,
    isActive,
    isRewriting,
    hasError: rewriteError !== null,
  });

  const accessibilityLabel = useMemo(() => {
    if (isActive) {
      return t("readAloud.stop");
    }
    if (isRewriting) {
      return t("readAloud.rewriting");
    }
    return kind === "rewritten" ? t("readAloud.playRewritten") : t("readAloud.play");
  }, [isActive, isRewriting, kind, t]);

  useEffect(() => {
    setRewriteError(null);
    setIsRewriting(false);
    requestRef.current += 1;
  }, [text, kind]);

  useEffect(() => {
    return () => {
      requestRef.current += 1;
    };
  }, []);

  const handlePress = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setRewriteError(null);
    if (isActive) {
      await player.stop();
      return;
    }
    if (kind === "raw") {
      try {
        await player.speakRaw(text, buttonKey);
      } catch {
        if (requestRef.current === requestId) {
          setRewriteError(t("readAloud.errors.failed"));
        }
      }
      return;
    }
    if (!client || !supportsRewrite) {
      return;
    }
    setIsRewriting(true);
    try {
      const payload = await client.rewriteTextForSpeech(text, {
        timeout: READ_ALOUD_REWRITE_TIMEOUT_MS,
      });
      if (requestRef.current !== requestId) {
        return;
      }
      if (payload.error || !payload.rewrittenText) {
        setRewriteError(t("readAloud.errors.failed"));
        return;
      }
      await player.speakRewritten(text, payload.rewrittenText, buttonKey);
    } catch {
      if (requestRef.current === requestId) {
        setRewriteError(t("readAloud.errors.failed"));
      }
    } finally {
      if (requestRef.current === requestId) {
        setIsRewriting(false);
      }
    }
  }, [buttonKey, client, isActive, kind, player, supportsRewrite, t, text]);

  if (kind === "rewritten" && !supportsRewrite) {
    return null;
  }

  if (!showControls) {
    return null;
  }

  return (
    <View style={readAloudButtonStylesheet.container}>
      <Pressable
        onPress={handlePress}
        disabled={isRewriting}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        testID={testID ?? (kind === "rewritten" ? "read-aloud-rewritten" : "read-aloud-raw")}
        style={readAloudButtonStylesheet.button}
        hitSlop={6}
      >
        <ReadAloudButtonIcon active={isActive} kind={kind} />
      </Pressable>
      {rewriteError ? (
        <Text style={readAloudButtonStylesheet.errorText}>{rewriteError}</Text>
      ) : null}
    </View>
  );
});

export const ReadAloudButtons = memo(function ReadAloudButtons({
  text,
  client,
  supportsRewrite,
  visible = true,
  testID,
}: ReadAloudButtonGroupProps) {
  return (
    <View style={readAloudButtonStylesheet.group}>
      <ReadAloudButton
        text={text}
        kind="raw"
        client={client}
        supportsRewrite={supportsRewrite}
        visible={visible}
        testID={testID ? `${testID}-raw` : undefined}
      />
      <ReadAloudButton
        text={text}
        kind="rewritten"
        client={client}
        supportsRewrite={supportsRewrite}
        visible={visible}
        testID={testID ? `${testID}-rewritten` : undefined}
      />
    </View>
  );
});

export function resetReadAloudVoiceCache(): void {
  resetOnDeviceReadAloudVoiceCache();
}

const readAloudButtonStylesheet = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  group: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  button: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 24,
    minHeight: 24,
  },
  sparkleBadge: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  sparkleOverlay: {
    position: "absolute",
    top: -4,
    right: -6,
  },
  errorText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
    flexShrink: 1,
  },
}));

export function shouldShowReadAloudControls(input: {
  visible: boolean;
  isActive: boolean;
  isRewriting: boolean;
  hasError: boolean;
}): boolean {
  return input.visible || input.isActive || input.isRewriting || input.hasError;
}
