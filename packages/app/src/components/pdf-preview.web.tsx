import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, type LayoutChangeEvent, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Document, Page, pdfjs } from "react-pdf";
import { StyleSheet } from "react-native-unistyles";
import { SPACING } from "@/styles/theme";
import { isWeb } from "@/constants/platform";
import type { PdfPreviewProps } from "./pdf-preview";

if (isWeb && !pdfjs.GlobalWorkerOptions.workerPort) {
  pdfjs.GlobalWorkerOptions.workerPort = new Worker(
    new URL("./pdf-preview-worker.web", window.location.href),
    { type: "module" },
  );
}

interface PdfLoadState {
  uri: string;
  pageCount: number | null;
  failed: boolean;
}

function PdfLoadingIndicator() {
  return <ActivityIndicator size="small" />;
}

export function PdfPreview({ uri, label }: PdfPreviewProps) {
  const { t } = useTranslation();
  const [viewportWidth, setViewportWidth] = useState(0);
  const [loadState, setLoadState] = useState<PdfLoadState>({
    uri,
    pageCount: null,
    failed: false,
  });
  const currentState = loadState.uri === uri ? loadState : null;
  const pageCount = currentState?.pageCount ?? null;
  const failed = currentState?.failed ?? false;
  const pageWidth = Math.max(1, viewportWidth - SPACING[4] * 2);
  const pageNumbers = useMemo(
    () => (pageCount ? Array.from({ length: pageCount }, (_, index) => index + 1) : []),
    [pageCount],
  );
  const measureViewport = useCallback((event: LayoutChangeEvent) => {
    setViewportWidth(event.nativeEvent.layout.width);
  }, []);
  const showDocument = useCallback(
    ({ numPages }: { numPages: number }) => {
      setLoadState({ uri, pageCount: numPages, failed: false });
    },
    [uri],
  );
  const showLoadError = useCallback(() => {
    setLoadState({ uri, pageCount: null, failed: true });
  }, [uri]);

  if (failed) {
    return (
      <View style={styles.centerState} accessibilityLabel={label}>
        <Text style={styles.errorText}>{t("panels.file.failedToLoadPreview")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} accessibilityLabel={label} onLayout={measureViewport}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator
      >
        <Document
          file={uri}
          loading={PdfLoadingIndicator}
          error={null}
          noData={null}
          onLoadSuccess={showDocument}
          onLoadError={showLoadError}
          onSourceError={showLoadError}
        >
          {viewportWidth > 0
            ? pageNumbers.map((pageNumber) => (
                <View key={pageNumber} style={styles.page}>
                  <Page
                    pageNumber={pageNumber}
                    width={pageWidth}
                    loading={null}
                    renderAnnotationLayer={false}
                    renderTextLayer={false}
                  />
                </View>
              ))
            : null}
        </Document>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  scrollView: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: "center",
    padding: SPACING[4],
  },
  page: {
    marginBottom: theme.spacing[3],
    ...theme.shadow.sm,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
