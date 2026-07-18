import { Check, ChevronDown, ChevronUp, RotateCw, X, type LucideIcon } from "lucide-react-native";
import { forwardRef, useCallback, useMemo } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";

interface ChatHistorySearchBarProps {
  query: string;
  onQueryChange: (value: string) => void;
  includeUser: boolean;
  includeAssistant: boolean;
  onIncludeUserChange: (value: boolean) => void;
  onIncludeAssistantChange: (value: boolean) => void;
  current: number;
  total: number;
  isLoading: boolean;
  isIncomplete: boolean;
  hasError: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onRetry: () => void;
  onClose: () => void;
}

export const ChatHistorySearchBar = forwardRef<TextInput, ChatHistorySearchBarProps>(
  function ChatHistorySearchBar(
    {
      query,
      onQueryChange,
      includeUser,
      includeAssistant,
      onIncludeUserChange,
      onIncludeAssistantChange,
      current,
      total,
      isLoading,
      isIncomplete,
      hasError,
      onPrevious,
      onNext,
      onRetry,
      onClose,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const hasResults = total > 0;
    const resultText = hasResults
      ? t("agentStream.search.resultPosition", { current, total })
      : t("agentStream.search.noResults");
    const handleKeyPress = useCallback(
      (event: { nativeEvent: { key: string; shiftKey?: boolean } }) => {
        if (event.nativeEvent.key === "Escape") {
          onClose();
        } else if (event.nativeEvent.key === "Enter") {
          if (event.nativeEvent.shiftKey) onPrevious();
          else onNext();
        }
      },
      [onClose, onNext, onPrevious],
    );
    const toggleUser = useCallback(
      () => onIncludeUserChange(!includeUser),
      [includeUser, onIncludeUserChange],
    );
    const toggleAssistant = useCallback(
      () => onIncludeAssistantChange(!includeAssistant),
      [includeAssistant, onIncludeAssistantChange],
    );

    return (
      <View style={styles.root} testID="chat-history-search">
        <View style={styles.inputRow}>
          <TextInput
            ref={ref}
            value={query}
            onChangeText={onQueryChange}
            placeholder={t("agentStream.search.placeholder")}
            placeholderTextColor={styles.placeholder.color}
            style={styles.input}
            testID="chat-history-search-input"
            accessibilityLabel={t("agentStream.search.label")}
            onKeyPress={handleKeyPress}
          />
          <Text style={styles.resultText} testID="chat-history-search-count">
            {isIncomplete && hasResults ? `${resultText}+` : resultText}
          </Text>
          {isLoading ? (
            <ActivityIndicator size="small" testID="chat-history-search-loading" />
          ) : null}
          {hasError ? (
            <SearchIconButton
              label={t("agentStream.search.retry")}
              onPress={onRetry}
              icon={RotateCw}
              iconSize={16}
              testID="chat-history-search-retry"
            />
          ) : null}
          <SearchIconButton
            label={t("agentStream.search.previous")}
            onPress={onPrevious}
            disabled={!hasResults}
            icon={ChevronUp}
            testID="chat-history-search-previous"
          />
          <SearchIconButton
            label={t("agentStream.search.next")}
            onPress={onNext}
            disabled={!hasResults}
            icon={ChevronDown}
            testID="chat-history-search-next"
          />
          <SearchIconButton
            label={t("agentStream.search.close")}
            onPress={onClose}
            icon={X}
            testID="chat-history-search-close"
          />
        </View>
        <View style={styles.filters}>
          <RoleFilter
            checked={includeUser}
            label={t("agentStream.search.user")}
            onPress={toggleUser}
            testID="chat-history-search-filter-user"
          />
          <RoleFilter
            checked={includeAssistant}
            label={t("agentStream.search.assistant")}
            onPress={toggleAssistant}
            testID="chat-history-search-filter-assistant"
          />
          {isLoading ? <Text style={styles.status}>{t("agentStream.search.loading")}</Text> : null}
          {hasError ? (
            <Text style={styles.status}>{t("agentStream.search.incomplete")}</Text>
          ) : null}
        </View>
      </View>
    );
  },
);

function SearchIconButton({
  label,
  onPress,
  icon: Icon,
  iconSize = 17,
  disabled = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  icon: LucideIcon;
  iconSize?: number;
  disabled?: boolean;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      style={disabled ? styles.iconButtonDisabled : styles.iconButton}
    >
      <Icon size={iconSize} />
    </Pressable>
  );
}

function RoleFilter({
  checked,
  label,
  onPress,
  testID,
}: {
  checked: boolean;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  const accessibilityState = useMemo(() => ({ checked }), [checked]);
  const checkboxStyle = useMemo(
    () => [styles.checkbox, checked && styles.checkboxChecked],
    [checked],
  );
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={accessibilityState}
      onPress={onPress}
      testID={testID}
      style={styles.filter}
    >
      <View style={checkboxStyle}>{checked ? <Check size={12} /> : null}</View>
      <Text style={styles.filterLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  inputRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  input: {
    flex: 1,
    minWidth: 80,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  placeholder: { color: theme.colors.foregroundMuted },
  resultText: { color: theme.colors.foregroundMuted, fontSize: 12 },
  iconButton: { padding: theme.spacing[1], borderRadius: theme.borderRadius.sm },
  iconButtonDisabled: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    opacity: 0.35,
  },
  filters: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  filter: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  checkbox: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 3,
  },
  checkboxChecked: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
  filterLabel: { color: theme.colors.foreground, fontSize: 12 },
  status: { color: theme.colors.foregroundMuted, fontSize: 12 },
}));
