import { memo, useCallback, useMemo } from "react";
import { FlatList, ScrollView, Text, View, type ListRenderItem } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useAppSettings } from "@/hooks/use-settings";
import { layoutTable, parseDelimited, type TableDelimiter, type TableLayout } from "./parse";

const ROW_HEIGHT = 28;
const CELL_PADDING = 8;
/**
 * A monospace glyph's advance as a share of the font size, rounded up: an estimate a little
 * short truncates every cell sized to its longest value.
 */
const CHAR_WIDTH = 0.65;

interface TableRow {
  number: number;
  cells: readonly string[];
}

/**
 * A CSV or TSV file as a table: the first row is a header that stays on screen, rows are numbered
 * like the file's records, and number columns align to the end. Rows render as they scroll into
 * view, and each cell shows one line.
 */
export function TableView({ text, delimiter }: { text: string; delimiter: TableDelimiter }) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const parsed = useMemo(() => {
    const rows = parseDelimited(text, delimiter);
    return { rows, layout: layoutTable(rows) };
  }, [delimiter, text]);
  const charWidth = settings.codeFontSize * CHAR_WIDTH;
  const widths = useMemo(() => {
    const numberDigits = String(Math.max(parsed.rows.length - 1, 1)).length;
    return {
      number: Math.ceil((numberDigits + 1) * charWidth) + CELL_PADDING * 2,
      columns: parsed.layout.widths.map(
        (chars) => Math.ceil((chars + 1) * charWidth) + CELL_PADDING * 2,
      ),
    };
  }, [charWidth, parsed]);
  const data = useMemo<TableRow[]>(
    () => parsed.rows.slice(1).map((cells, index) => ({ number: index + 1, cells })),
    [parsed.rows],
  );
  const renderRow = useCallback<ListRenderItem<TableRow>>(
    ({ item }) => (
      <TableRowView
        number={String(item.number)}
        cells={item.cells}
        layout={parsed.layout}
        widths={widths}
      />
    ),
    [parsed.layout, widths],
  );
  const header = parsed.rows[0];
  if (!header) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>{t("panels.file.table.empty")}</Text>
      </View>
    );
  }
  const totalWidth = widths.number + widths.columns.reduce((sum, width) => sum + width, 0);
  return (
    <ScrollView horizontal style={styles.container} testID="file-table-preview">
      <View style={[styles.grid, { width: totalWidth }]}>
        <TableRowView number="" cells={header} layout={parsed.layout} widths={widths} header />
        <FlatList
          data={data}
          keyExtractor={rowKey}
          renderItem={renderRow}
          getItemLayout={rowLayout}
          initialNumToRender={40}
          windowSize={9}
        />
      </View>
    </ScrollView>
  );
}

const TableRowView = memo(function TableRowView({
  number,
  cells,
  layout,
  widths,
  header = false,
}: {
  number: string;
  cells: readonly string[];
  layout: TableLayout;
  widths: { number: number; columns: number[] };
  header?: boolean;
}) {
  return (
    <View
      style={header ? styles.headerRow : styles.row}
      testID={header ? "file-table-header" : undefined}
    >
      <Text style={[styles.cell, styles.rowNumber, { width: widths.number }]} numberOfLines={1}>
        {number}
      </Text>
      {widths.columns.map((width, column) => (
        <Text
          // Columns never reorder, so the index identifies the cell.
          // eslint-disable-next-line react/no-array-index-key
          key={column}
          style={[
            styles.cell,
            header ? styles.headerCell : null,
            layout.numeric[column] && !header ? styles.numericCell : null,
            { width },
          ]}
          numberOfLines={1}
          selectable
        >
          {cells[column] ?? ""}
        </Text>
      ))}
    </View>
  );
});

function rowKey(row: TableRow): string {
  return String(row.number);
}

function rowLayout(_data: ArrayLike<TableRow> | null | undefined, index: number) {
  return { length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index };
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  grid: { flex: 1, minHeight: 0 },
  row: {
    height: ROW_HEIGHT,
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  headerRow: {
    height: ROW_HEIGHT,
    flexDirection: "row",
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  cell: {
    height: ROW_HEIGHT,
    lineHeight: ROW_HEIGHT,
    paddingHorizontal: CELL_PADDING,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.colors.border,
  },
  headerCell: { fontWeight: theme.fontWeight.semibold },
  numericCell: { textAlign: "right" },
  rowNumber: { color: theme.colors.foregroundExtraMuted, textAlign: "right" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[4] },
  emptyText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));
