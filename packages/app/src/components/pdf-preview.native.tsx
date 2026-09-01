import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import Pdf from "react-native-pdf";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { PdfPreviewProps } from "./pdf-preview";

function PdfLoadingIndicator() {
  return <ActivityIndicator size="small" />;
}

export function PdfPreview({ uri, label }: PdfPreviewProps) {
  const { t } = useTranslation();
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const source = useMemo(() => ({ uri }), [uri]);
  const showLoadError = useCallback(() => setFailedUri(uri), [uri]);

  if (failedUri === uri) {
    return (
      <View style={styles.centerState} accessibilityLabel={label}>
        <Text style={styles.errorText}>{t("panels.file.failedToLoadPreview")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} accessibilityLabel={label}>
      <Pdf
        source={source}
        style={styles.pdf}
        trustAllCerts={false}
        renderActivityIndicator={PdfLoadingIndicator}
        onError={showLoadError}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  pdf: {
    flex: 1,
    minHeight: 0,
    width: "100%",
    backgroundColor: theme.colors.surface0,
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
