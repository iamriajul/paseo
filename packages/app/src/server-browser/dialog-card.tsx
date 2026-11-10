import { useCallback, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Button } from "@/components/ui/button";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import type { ServerBrowserTab } from "./store";

type PageDialog = NonNullable<ServerBrowserTab["dialog"]>;

const ThemedTextInput = withUnistyles(EditingTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The page's alert, confirm, prompt or leave-page dialog, for the user to answer, over the page as
 * a browser shows it. Every viewer of the tab sees it; the first answer closes it for all.
 */
export function ServerBrowserDialogCard(props: {
  client: DaemonClient;
  browserId: string;
  dialog: PageDialog;
  run: (action: () => Promise<void> | undefined) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { client, browserId, dialog, run } = props;
  const inputRef = useRef<EditingTextInputHandle | null>(null);
  const leaving = dialog.type === "beforeunload";
  const answer = useCallback(
    (accept: boolean) =>
      run(() =>
        client.serverBrowserAnswerDialog(browserId, {
          dialogId: dialog.id,
          accept,
          ...(accept && dialog.type === "prompt"
            ? { promptText: inputRef.current?.getText() ?? "" }
            : {}),
        }),
      ),
    [browserId, client, dialog.id, dialog.type, run],
  );
  const accept = useCallback(() => answer(true), [answer]);
  const dismiss = useCallback(() => answer(false), [answer]);
  return (
    <View style={styles.scrim} testID="server-browser-dialog">
      <View style={styles.card} role="alertdialog">
        <Text style={styles.title}>
          {leaving
            ? t("workspace.browser.dialog.leaveTitle")
            : t("workspace.browser.dialog.says", { host: hostOf(dialog.url) })}
        </Text>
        <Text style={styles.message} selectable>
          {leaving ? t("workspace.browser.dialog.leaveMessage") : dialog.message}
        </Text>
        {dialog.type === "prompt" ? (
          <ThemedTextInput
            ref={inputRef}
            accessibilityLabel={dialog.message}
            initialValue={dialog.defaultPrompt ?? ""}
            onSubmitEditing={accept}
            autoFocus
            style={styles.input}
            testID="server-browser-dialog-input"
          />
        ) : null}
        <View style={styles.actions}>
          {dialog.type === "alert" ? null : (
            <Button
              size="sm"
              variant="secondary"
              onPress={dismiss}
              testID="server-browser-dialog-cancel"
            >
              {leaving ? t("workspace.browser.dialog.stay") : t("workspace.browser.dialog.cancel")}
            </Button>
          )}
          <Button size="sm" onPress={accept} testID="server-browser-dialog-ok">
            {leaving ? t("workspace.browser.dialog.leave") : t("workspace.browser.dialog.ok")}
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
  message: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  input: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
