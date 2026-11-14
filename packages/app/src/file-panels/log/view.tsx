import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  FlatList,
  ScrollView,
  Text,
  View,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { PluginFile } from "@getpaseo/plugin/client";
import { Button } from "@/components/ui/button";
import { useAppSettings } from "@/hooks/use-settings";
import { formatFileSize } from "@/utils/format-file-size";
import type { OpenByteRange } from "../byte-range";
import { FilePanelLoading } from "../loading";
import { displayLogLine, LogTail, TAIL_CHUNK_BYTES, type ReadBytes } from "./tail";

const CELL_PADDING = 12;
/** A monospace glyph's advance as a share of the font size, rounded up. */
const CHAR_WIDTH = 0.65;
/** Lines wider than this many characters scroll no further; the rest of the line is cut. */
const MAX_LINE_CHARS = 2000;
/** "Load earlier" or "Start of file" sits above the first line, two rows tall. */
const HEADER_ROWS = 2;

interface LogLine {
  index: number;
  text: string;
}

/**
 * The end of a log file, following it as it grows: at the bottom it keeps the newest line in
 * view; scrolled up it stays put and offers a way back. Lines keep one row each and scroll
 * sideways, so rows have one height and loading earlier lines keeps the view where it was.
 */
export function LogTailView({ file, open }: { file: PluginFile; open: OpenByteRange }) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const rowHeight = Math.ceil(settings.codeFontSize * 1.6);
  const charWidth = settings.codeFontSize * CHAR_WIDTH;
  const tail = useLogTail(file, open);
  const snapshot = useSyncExternalStore(tail.subscribe, tail.getSnapshot, tail.getSnapshot);
  const listRef = useRef<FlatList<LogLine>>(null);
  const following = useRef(true);
  const scrollOffset = useRef(0);
  const prepended = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const data = useMemo<LogLine[]>(
    () => snapshot.lines.map((line, index) => ({ index, text: displayLogLine(line) })),
    [snapshot.lines],
  );
  const width = useMemo(() => {
    let chars = 0;
    for (const line of data) chars = Math.max(chars, Math.min(line.text.length, MAX_LINE_CHARS));
    return Math.ceil((chars + 1) * charWidth) + CELL_PADDING * 2;
  }, [charWidth, data]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      scrollOffset.current = contentOffset.y;
      const atEnd = contentOffset.y + layoutMeasurement.height >= contentSize.height - rowHeight;
      following.current = atEnd;
      setShowJump(!atEnd);
    },
    [rowHeight],
  );
  const handleContentSizeChange = useCallback(() => {
    if (prepended.current > 0) {
      const offset = scrollOffset.current + prepended.current * rowHeight;
      prepended.current = 0;
      listRef.current?.scrollToOffset({ offset, animated: false });
    } else if (following.current) {
      listRef.current?.scrollToEnd({ animated: false });
    }
  }, [rowHeight]);
  const jumpToEnd = useCallback(() => {
    following.current = true;
    setShowJump(false);
    listRef.current?.scrollToEnd({ animated: false });
  }, []);
  // Earlier lines land above the ones on screen; the next content size change scrolls past them.
  const shown = useRef({ start: snapshot.start, count: snapshot.lines.length });
  useLayoutEffect(() => {
    if (snapshot.start < shown.current.start) {
      prepended.current += snapshot.lines.length - shown.current.count;
    }
    shown.current = { start: snapshot.start, count: snapshot.lines.length };
  }, [snapshot]);
  const loadEarlier = useCallback(async () => {
    setLoadingEarlier(true);
    await tail.loadEarlier();
    setLoadingEarlier(false);
  }, [tail]);
  const retry = useCallback(() => void tail.sync(file.size), [file, tail]);
  const rowLayout = useCallback(
    (_data: ArrayLike<LogLine> | null | undefined, index: number) => ({
      length: rowHeight,
      offset: rowHeight * (index + HEADER_ROWS),
      index,
    }),
    [rowHeight],
  );
  const renderLine = useCallback<ListRenderItem<LogLine>>(
    ({ item }) => <LogLineView text={item.text} height={rowHeight} />,
    [rowHeight],
  );

  const header = useMemo(
    () => (
      <LogTailHeader
        height={rowHeight * HEADER_ROWS}
        canLoadEarlier={snapshot.start > 0}
        loading={loadingEarlier}
        onLoadEarlier={loadEarlier}
      />
    ),
    [loadEarlier, loadingEarlier, rowHeight, snapshot.start],
  );

  if (snapshot.status === "loading") return <FilePanelLoading />;
  if (snapshot.status === "failed") {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>{snapshot.error ?? t("panels.file.failedToLoad")}</Text>
        <Button variant="outline" onPress={retry}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }
  return (
    <View style={styles.container}>
      <ScrollView horizontal style={styles.container} contentContainerStyle={styles.sideways}>
        <View style={[styles.lines, { minWidth: width }]}>
          <FlatList
            ref={listRef}
            data={data}
            keyExtractor={lineKey}
            renderItem={renderLine}
            getItemLayout={rowLayout}
            ListHeaderComponent={header}
            onScroll={handleScroll}
            scrollEventThrottle={64}
            onContentSizeChange={handleContentSizeChange}
            initialNumToRender={80}
            windowSize={9}
            testID="file-log-tail"
          />
        </View>
      </ScrollView>
      {showJump ? (
        <View style={styles.jump} pointerEvents="box-none">
          <Button variant="outline" size="sm" onPress={jumpToEnd} testID="file-log-jump-to-end">
            {t("panels.file.log.jumpToEnd")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

/** Above the first line: Load earlier, or the start of the file once it is shown. */
function LogTailHeader({
  height,
  canLoadEarlier,
  loading,
  onLoadEarlier,
}: {
  height: number;
  canLoadEarlier: boolean;
  loading: boolean;
  onLoadEarlier: () => void;
}) {
  const { t } = useTranslation();
  const style = useMemo(() => [styles.header, { height }], [height]);
  return (
    <View style={style}>
      {canLoadEarlier ? (
        <Button
          variant="ghost"
          size="sm"
          onPress={onLoadEarlier}
          disabled={loading}
          testID="file-log-load-earlier"
        >
          {t("panels.file.log.loadEarlier", { size: formatFileSize(TAIL_CHUNK_BYTES) })}
        </Button>
      ) : (
        <Text style={styles.headerText}>{t("panels.file.log.startOfFile")}</Text>
      )}
    </View>
  );
}

/** One tail for the panel's file: it reads the end now, and again each time the file changes. */
function useLogTail(file: PluginFile, open: OpenByteRange): LogTail {
  const [state] = useState(() => {
    const abort = new AbortController();
    const read: ReadBytes = async (offset, length) => {
      if (length <= 0) return new Uint8Array(0);
      const chunks = await open({ start: offset, end: offset + length - 1 }, abort.signal);
      const parts: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of chunks) {
        parts.push(chunk);
        total += chunk.length;
      }
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const part of parts) {
        bytes.set(part, at);
        at += part.length;
      }
      return bytes;
    };
    return { tail: new LogTail(read), abort };
  });
  useEffect(() => {
    void state.tail.sync(file.size);
    const unwatch = file.watch((event) => {
      if (event.type === "changed") void state.tail.sync(file.size);
    });
    return unwatch;
  }, [file, state]);
  useEffect(
    () => () => {
      state.abort.abort();
      state.tail.dispose();
    },
    [state],
  );
  return state.tail;
}

const LogLineView = memo(function LogLineView({ text, height }: { text: string; height: number }) {
  return (
    <Text style={[styles.line, { height, lineHeight: height }]} numberOfLines={1} selectable>
      {text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text}
    </Text>
  );
});

function lineKey(line: LogLine): string {
  return String(line.index);
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  sideways: { flexGrow: 1 },
  lines: { flex: 1, minHeight: 0 },
  header: { justifyContent: "center", alignItems: "flex-start", paddingHorizontal: CELL_PADDING },
  headerText: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  line: {
    paddingHorizontal: CELL_PADDING,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  jump: {
    position: "absolute",
    right: theme.spacing[4],
    bottom: theme.spacing[4],
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
