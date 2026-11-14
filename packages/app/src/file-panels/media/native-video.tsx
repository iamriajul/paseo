import { useEffect } from "react";
import { useVideoPlayer, VideoView } from "expo-video";
import { StyleSheet } from "react-native-unistyles";

/** expo-video plays both: AVPlayer and ExoPlayer show their own controls for an audio file too. */
export function NativeVideo({
  uri,
  kind,
  label,
  onError,
}: {
  uri: string;
  kind: "video" | "audio";
  label: string;
  onError: () => void;
}) {
  const player = useVideoPlayer(uri);
  useEffect(() => {
    const subscription = player.addListener("statusChange", ({ status }) => {
      if (status === "error") onError();
    });
    return () => subscription.remove();
  }, [onError, player]);
  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      fullscreenOptions={kind === "video" ? FULLSCREEN : NO_FULLSCREEN}
      accessibilityLabel={label}
      testID="media-file-preview"
      style={kind === "video" ? styles.video : styles.audio}
    />
  );
}

const FULLSCREEN = { enable: true };
const NO_FULLSCREEN = { enable: false };

const styles = StyleSheet.create((theme) => ({
  video: {
    flex: 1,
    minHeight: 0,
    backgroundColor: "#000",
  },
  audio: {
    height: 160,
    marginVertical: "auto",
    marginHorizontal: theme.spacing[4],
  },
}));
