import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ServerBrowserConsoleEntry } from "@getpaseo/protocol/server-browser/rpc-schemas";
import { Button } from "@/components/ui/button";

// The panel reads the tab's console this often while it is open; the daemon keeps 200 lines.
const POLL_MS = 1_000;
const MAX_LINES = 500;

/** Polls a tab's console after the last line this viewer has, while the panel is open. */
export function useServerBrowserLogs(input: {
  client: DaemonClient | null;
  browserId: string;
  open: boolean;
}): { entries: ServerBrowserConsoleEntry[]; clear: () => void } {
  const { client, browserId, open } = input;
  const [entries, setEntries] = useState<ServerBrowserConsoleEntry[]>([]);
  const lastSeqRef = useRef(0);

  useEffect(() => {
    lastSeqRef.current = 0;
    setEntries([]);
  }, [browserId]);

  useEffect(() => {
    if (!open || !client) return undefined;
    let cancelled = false;
    const read = async () => {
      try {
        const next = await client.serverBrowserLogs(browserId, lastSeqRef.current);
        if (cancelled || next.length === 0) return;
        lastSeqRef.current = next.at(-1)!.seq;
        setEntries((current) => [...current, ...next].slice(-MAX_LINES));
      } catch {
        // The tab closed or the host went away; the panel keeps what it has.
      }
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [browserId, client, open]);

  const clear = useCallback(() => setEntries([]), []);
  return { entries, clear };
}

/** The tab's console, as agents read it with browser_logs, under the page. */
export function ServerBrowserLogsPanel(props: {
  entries: ServerBrowserConsoleEntry[];
  onClear: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const scrollRef = useRef<ScrollView | null>(null);
  const handleContentSize = useCallback(
    () => scrollRef.current?.scrollToEnd({ animated: false }),
    [],
  );
  return (
    <View style={styles.panel} testID="server-browser-console">
      <View style={styles.header}>
        <Text style={styles.title}>{t("workspace.browser.console.title")}</Text>
        <Button
          size="sm"
          variant="ghost"
          onPress={props.onClear}
          testID="server-browser-console-clear"
        >
          {t("workspace.browser.console.clear")}
        </Button>
      </View>
      <ScrollView ref={scrollRef} style={styles.lines} onContentSizeChange={handleContentSize}>
        {props.entries.length === 0 ? (
          <Text style={styles.empty}>{t("workspace.browser.console.empty")}</Text>
        ) : (
          props.entries.map((entry) => <ConsoleLine key={entry.seq} entry={entry} />)
        )}
      </ScrollView>
    </View>
  );
}

function levelOf(entry: ServerBrowserConsoleEntry): "error" | "warning" | "log" {
  if (entry.level === "error") return "error";
  if (entry.level === "warning") return "warning";
  return "log";
}

function ConsoleLine({ entry }: { entry: ServerBrowserConsoleEntry }): ReactElement {
  const level = levelOf(entry);
  const where = entry.source
    ? `${entry.source}${entry.line !== undefined ? `:${entry.line}` : ""}`
    : null;
  return (
    <View style={styles.line}>
      <Text
        style={[
          styles.message,
          level === "error" && styles.errorText,
          level === "warning" && styles.warningText,
        ]}
        selectable
      >
        {entry.message}
      </Text>
      {where ? (
        <Text style={styles.where} numberOfLines={1}>
          {where}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    height: 200,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  lines: {
    flex: 1,
  },
  empty: {
    padding: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  line: {
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  message: {
    flex: 1,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
  },
  errorText: {
    color: theme.colors.destructive,
  },
  warningText: {
    color: theme.colors.statusWarning,
  },
  where: {
    maxWidth: 200,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foregroundMuted,
  },
}));
