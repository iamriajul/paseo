import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { formatFileSize } from "@/utils/format-file-size";
import { filePanelExtension } from "../resolve";
import { useMediaAccess } from "./access";
import { MediaMessage } from "./message";
import type { OpenByteRange } from "./range-reader";
import type { MediaPlayerProps } from "./types";

/** A whole-file load: as much in flight as a session download. */
const READ_AHEAD = { sliceBytes: 2 * 1024 * 1024, depth: 3 };
/** Larger files wait for a tap, so opening one never spends a phone's data unasked. */
const AUTO_LOAD_MAX_BYTES = 50 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 250;
// An app binary older than this JS (an OTA update) has no video module.
const hasVideoModule = requireOptionalNativeModule("ExpoVideo") !== null;

/**
 * iOS and Android players read a URL, and only a direct connection has a daemon URL, so the file
 * streams over the session into the app's cache first, a slice at a time, and plays from there
 * with full seeking. The copy is deleted when the panel closes.
 */
export function MediaPlayer(props: MediaPlayerProps) {
  const { t } = useTranslation();
  const access = useMediaAccess({ ...props, readAhead: READ_AHEAD });
  if (access.status === "update-host") {
    return <MediaMessage message={t("panels.file.media.updateHost")} />;
  }
  if (access.status === "unavailable") {
    return <MediaMessage message={t("panels.file.failedToLoadPreview")} tone="error" />;
  }
  if (!hasVideoModule) return <MediaMessage message={t("panels.file.media.updateApp")} />;
  if (props.size === 0) {
    return <MediaMessage message={t("panels.file.media.unsupported")} tone="error" />;
  }
  return <CachedMediaPlayer {...props} open={access.open} />;
}

type CacheState =
  | { status: "loading"; received: number }
  | { status: "ready"; uri: string }
  | { status: "failed"; message: string };

function CachedMediaPlayer({
  format,
  size,
  path,
  label,
  open,
}: MediaPlayerProps & { open: OpenByteRange }) {
  const { t } = useTranslation();
  const [started, setStarted] = useState(size <= AUTO_LOAD_MAX_BYTES);
  const [state, setState] = useState<CacheState>({ status: "loading", received: 0 });
  const extension = filePanelExtension(path);
  const start = useCallback(() => setStarted(true), []);

  useEffect(() => {
    if (!started) return;
    const abort = new AbortController();
    const file = new File(cacheDirectory(), `${randomName()}.${extension}`);
    let reported = 0;
    async function load() {
      try {
        await loadToFile({
          open,
          size,
          file,
          signal: abort.signal,
          onProgress: (received) => {
            const now = Date.now();
            if (now - reported < PROGRESS_INTERVAL_MS) return;
            reported = now;
            setState({ status: "loading", received });
          },
        });
        if (!abort.signal.aborted) setState({ status: "ready", uri: file.uri });
      } catch (error) {
        if (abort.signal.aborted) return;
        setState({ status: "failed", message: error instanceof Error ? error.message : "" });
      }
    }
    void load();
    return () => {
      abort.abort();
      deleteQuietly(file);
    };
  }, [extension, open, size, started]);

  if (!started) {
    return (
      <MediaMessage message={t("panels.file.media.confirmLoad", { size: formatFileSize(size) })}>
        <Button variant="outline" onPress={start}>
          {t("panels.file.media.loadAndPlay")}
        </Button>
      </MediaMessage>
    );
  }
  if (state.status === "failed") {
    return <MediaMessage message={state.message || t("panels.file.media.failed")} tone="error" />;
  }
  if (state.status === "loading") {
    return (
      <MediaMessage
        message={t("panels.file.media.loading", {
          received: formatFileSize(state.received),
          total: formatFileSize(size),
        })}
      >
        <ProgressBar fraction={state.received / size} />
      </MediaMessage>
    );
  }
  return <NativeMedia uri={state.uri} kind={format.kind} label={label} />;
}

let nativeVideo: typeof import("./native-video") | null = null;

/** Required only once the binary is known to have the module: importing expo-video throws without it. */
function loadNativeVideo(): typeof import("./native-video") {
  nativeVideo ??= require("./native-video") as typeof import("./native-video");
  return nativeVideo;
}

function NativeMedia(props: { uri: string; kind: "video" | "audio"; label: string }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);
  if (failed) return <MediaMessage message={t("panels.file.media.unsupported")} tone="error" />;
  const { NativeVideo } = loadNativeVideo();
  return <NativeVideo {...props} onError={fail} />;
}

function ProgressBar({ fraction }: { fraction: number }) {
  const width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` as const;
  return (
    <View style={styles.track}>
      <View style={[styles.fill, { width }]} />
    </View>
  );
}

async function loadToFile(input: {
  open: OpenByteRange;
  size: number;
  file: File;
  signal: AbortSignal;
  onProgress: (received: number) => void;
}): Promise<void> {
  const { open, size, file, signal, onProgress } = input;
  const chunks = await open({ start: 0, end: size - 1 }, signal);
  file.create();
  const handle = file.open(FileMode.WriteOnly);
  try {
    let received = 0;
    for await (const chunk of chunks) {
      handle.writeBytes(chunk);
      received += chunk.byteLength;
      onProgress(received);
    }
  } finally {
    handle.close();
  }
}

function cacheDirectory(): Directory {
  const directory = new Directory(Paths.cache, "media-preview");
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function randomName(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function deleteQuietly(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // The cache is the OS's to clear; a file left behind is not worth an error.
  }
}

const styles = StyleSheet.create((theme) => ({
  track: {
    width: 200,
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    backgroundColor: theme.colors.foreground,
  },
}));
