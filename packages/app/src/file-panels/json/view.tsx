import { memo, useCallback, useMemo, useState } from "react";
import { FlatList, Text, View, type ListRenderItem } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { Theme } from "@/styles/theme";
import {
  initiallyOpen,
  isContainer,
  parseJsonDocument,
  visibleJsonRows,
  type JsonRow,
  type JsonValue,
} from "./model";

const ROW_HEIGHT = 24;
const INDENT = 16;
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedChevronDown = withUnistyles(ChevronDown);
const chevronColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * A JSON file as a tree: one entry per line, indented like the pretty-printed file, with each
 * object and array folding on a tap. A small file opens fully expanded; a large one opens on its
 * top-level entries.
 */
export function JsonTreeView({ text, jsonLines }: { text: string; jsonLines: boolean }) {
  const { t } = useTranslation();
  const document = useMemo(() => parseJsonDocument(text, jsonLines), [jsonLines, text]);
  const root = document.status === "ok" ? document.root : null;
  const [open, setOpen] = useState(() => (root === null ? new Set<string>() : initiallyOpen(root)));
  const rows = useMemo(() => (root === null ? [] : visibleJsonRows(root, open)), [open, root]);
  const toggle = useCallback((id: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const renderRow = useCallback<ListRenderItem<JsonRow>>(
    ({ item }) => <JsonRowView row={item} open={open.has(item.id)} onToggle={toggle} />,
    [open, toggle],
  );
  if (document.status === "error") {
    return (
      <View style={styles.message} testID="file-json-error">
        <Text style={styles.errorText}>
          {document.line === null
            ? t("panels.file.json.invalid")
            : t("panels.file.json.invalidAtLine", { line: document.line })}
        </Text>
        <Text style={styles.detail}>{document.message}</Text>
      </View>
    );
  }
  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.content}
      data={rows}
      extraData={open}
      keyExtractor={rowKey}
      renderItem={renderRow}
      getItemLayout={rowLayout}
      initialNumToRender={60}
      windowSize={9}
      testID="file-json-preview"
    />
  );
}

const JsonRowView = memo(function JsonRowView({
  row,
  open,
  onToggle,
}: {
  row: JsonRow;
  open: boolean;
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onToggle(row.id), [onToggle, row.id]);
  const indent = useMemo(() => ({ paddingLeft: row.depth * INDENT }), [row.depth]);
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  const key =
    row.key === null ? null : (
      <Text style={typeof row.key === "number" ? styles.index : styles.key}>
        {typeof row.key === "number" ? row.key : JSON.stringify(row.key)}
        <Text style={styles.punctuation}>: </Text>
      </Text>
    );
  if (row.size === null) {
    return (
      <View style={[styles.row, indent]}>
        <View style={styles.chevron} />
        <Text style={styles.line} numberOfLines={1} selectable>
          {key}
          <ScalarText value={row.value} />
        </Text>
      </View>
    );
  }
  const array = Array.isArray(row.value);
  const summary = array
    ? t("panels.file.json.items", { count: row.size })
    : t("panels.file.json.keys", { count: row.size });
  return (
    <PressHighlight
      style={[styles.row, indent]}
      highlightStyle={styles.pressed}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      testID="file-json-row"
    >
      <View style={styles.chevron}>
        {open ? (
          <ThemedChevronDown size={14} uniProps={chevronColor} />
        ) : (
          <ThemedChevronRight size={14} uniProps={chevronColor} />
        )}
      </View>
      <Text style={styles.line} numberOfLines={1}>
        {key}
        <Text style={styles.punctuation}>{array ? "[" : "{"}</Text>
        {open ? null : <Text style={styles.punctuation}>{array ? "…]" : "…}"}</Text>}
        <Text style={styles.summary}> {summary}</Text>
      </Text>
    </PressHighlight>
  );
});

function ScalarText({ value }: { value: JsonValue }) {
  if (isContainer(value)) return null;
  if (typeof value === "string") return <Text style={styles.string}>{JSON.stringify(value)}</Text>;
  if (typeof value === "number") return <Text style={styles.number}>{String(value)}</Text>;
  return <Text style={styles.literal}>{String(value)}</Text>;
}

function rowKey(row: JsonRow): string {
  return row.id;
}

function rowLayout(_data: ArrayLike<JsonRow> | null | undefined, index: number) {
  return { length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index };
}

const styles = StyleSheet.create((theme) => ({
  list: { flex: 1, minHeight: 0 },
  content: { paddingVertical: theme.spacing[2], paddingHorizontal: theme.spacing[2] },
  row: { height: ROW_HEIGHT, flexDirection: "row", alignItems: "center" },
  pressed: { backgroundColor: theme.colors.surface2 },
  chevron: { width: 18, alignItems: "center", justifyContent: "center" },
  line: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  key: { color: theme.colors.syntax.property },
  index: { color: theme.colors.foregroundMuted },
  punctuation: { color: theme.colors.foregroundMuted },
  summary: { color: theme.colors.foregroundExtraMuted },
  string: { color: theme.colors.syntax.string },
  number: { color: theme.colors.syntax.number },
  literal: { color: theme.colors.syntax.literal },
  message: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, textAlign: "center" },
}));
