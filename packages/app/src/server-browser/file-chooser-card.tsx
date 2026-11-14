import { useCallback, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Button } from "@/components/ui/button";
import { useFilePicker } from "@/hooks/use-file-picker";
import type { ServerBrowserTab } from "./store";

type FileChooser = NonNullable<ServerBrowserTab["fileChooser"]>;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/**
 * The page's file input asked for files. The viewer picks them on its own device (the composer's
 * picker), and they are uploaded to the host, where the page's input gets them.
 */
export function ServerBrowserFileChooserCard(props: {
  client: DaemonClient;
  browserId: string;
  chooser: FileChooser;
  run: (action: () => Promise<void> | undefined) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { client, browserId, chooser, run } = props;
  const { pickFiles } = useFilePicker();
  const [uploading, setUploading] = useState(false);
  const choose = useCallback(
    () =>
      run(async () => {
        const picked = await pickFiles();
        if (!picked || picked.length === 0) return;
        setUploading(true);
        try {
          const files = await Promise.all(
            (chooser.multiple ? picked : picked.slice(0, 1)).map(async (file) => ({
              name: file.fileName,
              dataBase64: bytesToBase64(await file.readBytes()),
            })),
          );
          await client.serverBrowserAnswerFileChooser(browserId, chooser.id, files);
        } finally {
          setUploading(false);
        }
      }),
    [browserId, chooser.id, chooser.multiple, client, pickFiles, run],
  );
  const chooseLabel = chooser.multiple
    ? t("workspace.browser.fileChooser.chooseMany")
    : t("workspace.browser.fileChooser.chooseOne");
  const cancel = useCallback(
    () => run(() => client.serverBrowserAnswerFileChooser(browserId, chooser.id, [])),
    [browserId, chooser.id, client, run],
  );
  return (
    <View style={styles.scrim} testID="server-browser-file-chooser">
      <View style={styles.card}>
        <Text style={styles.title}>
          {chooser.multiple
            ? t("workspace.browser.fileChooser.titleMany")
            : t("workspace.browser.fileChooser.titleOne")}
        </Text>
        <Text style={styles.detail}>{t("workspace.browser.fileChooser.detail")}</Text>
        <View style={styles.actions}>
          <Button
            variant="secondary"
            onPress={cancel}
            disabled={uploading}
            testID="server-browser-file-chooser-cancel"
          >
            {t("workspace.browser.fileChooser.cancel")}
          </Button>
          <Button onPress={choose} disabled={uploading} testID="server-browser-file-chooser-choose">
            {uploading ? t("workspace.browser.fileChooser.uploading") : chooseLabel}
          </Button>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingTop: theme.spacing[6],
    paddingHorizontal: theme.spacing[4],
    backgroundColor: "rgba(0, 0, 0, 0.32)",
  },
  card: {
    width: "100%",
    maxWidth: 440,
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  detail: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
