import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import { isWeb } from "@/constants/platform";
import { useByteRangeAccess } from "../byte-range";
import { TextFilePanel } from "../source/panel";
import { selectSourcePresentation } from "../source/readonly/presentation";
import { TextFileToolbar, type TextFileView } from "../source/toolbar";
import { LogTailView } from "./view";

/** One read per tail chunk: a log is read in small ranges, never streamed ahead. */
const READ_AHEAD = { sliceBytes: 256 * 1024, depth: 1 };

/**
 * Log: the end of the file, followed as it grows, read in byte ranges so a log of any size opens
 * at once over any connection. Source shows the whole file when it fits Source's budget, and opens
 * for a line target, whose line the tail cannot place.
 */
export function LogPanel(props: PluginFilePanelProps) {
  const { t } = useTranslation();
  const { file, params, host, workspaceId } = props;
  const access = useByteRangeAccess({
    serverId: host.id,
    workspaceId,
    path: params.path,
    readAhead: READ_AHEAD,
  });
  const sourceFits =
    selectSourcePresentation({ size: file.size, platform: isWeb ? "web" : "native" }) !==
    "unsupported";
  const [view, setView] = useState<"tail" | "source">(() =>
    sourceFits && (params.lineStart !== undefined || access.status !== "ready") ? "source" : "tail",
  );
  const showTail = useCallback(() => setView("tail"), []);
  const handleViewChange = useCallback((next: TextFileView) => {
    if (next === "tail" || next === "source") setView(next);
  }, []);

  if (view === "source") return <TextFilePanel {...props} onShowTail={showTail} />;
  return (
    <View style={styles.container}>
      <TextFileToolbar
        size={file.size}
        views={sourceFits ? LOG_VIEWS : undefined}
        view="tail"
        onViewChange={handleViewChange}
      />
      {access.status === "ready" ? (
        <LogTailView file={file} open={access.open} />
      ) : (
        <View style={styles.centerState}>
          <Text style={styles.mutedText}>
            {access.status === "update-host"
              ? t("panels.file.log.updateHost")
              : t("panels.file.failedToLoad")}
          </Text>
        </View>
      )}
    </View>
  );
}

const LOG_VIEWS: readonly TextFileView[] = ["tail", "source"];

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
