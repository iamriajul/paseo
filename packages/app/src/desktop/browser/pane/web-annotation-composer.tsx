import { useCallback, useRef, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { X } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import type { BrowserElementAnnotation } from "@/desktop/browser/browser-element-attachment";

const ThemedX = withUnistyles(X);
const ThemedCommentInput = withUnistyles(EditingTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

const mutedIconMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

interface WebAnnotationComposerProps {
  onSubmit: (annotation: BrowserElementAnnotation) => void;
  onCancel: () => void;
}

// Shown after the element picker returns a selection, before that selection
// becomes a chat attachment. The comment is read off the field on submit rather
// than mirrored into state, so typing does not re-render the pane behind it.
export function WebAnnotationComposer({
  onSubmit,
  onCancel,
}: WebAnnotationComposerProps): ReactElement {
  const { t } = useTranslation();
  const inputRef = useRef<EditingTextInputHandle | null>(null);
  const handleSubmit = useCallback(() => {
    onSubmit({ comment: inputRef.current?.getText() ?? "" });
  }, [onSubmit]);

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <View style={styles.card}>
        <View style={styles.header}>
          <Text numberOfLines={1} style={styles.title}>
            {t("workspace.browser.annotate.title")}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("workspace.browser.annotate.cancel")}
            onPress={onCancel}
            style={styles.close}
          >
            <ThemedX size={16} uniProps={mutedIconMapping} />
          </Pressable>
        </View>
        <ThemedCommentInput
          ref={inputRef}
          accessibilityLabel={t("workspace.browser.annotate.placeholder")}
          autoFocus
          multiline
          placeholder={t("workspace.browser.annotate.placeholder")}
          style={styles.input}
        />
        <View style={styles.actions}>
          <Button variant="ghost" size="sm" onPress={onCancel}>
            {t("workspace.browser.annotate.cancel")}
          </Button>
          <Button variant="default" size="sm" onPress={handleSubmit}>
            {t("workspace.browser.annotate.submit")}
          </Button>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: theme.spacing[3],
    alignItems: "center",
  },
  card: {
    width: "100%",
    maxWidth: 420,
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  close: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    minHeight: 72,
    maxHeight: 140,
    padding: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    fontSize: theme.fontSize.base,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
