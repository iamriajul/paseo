import React, { memo, useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { Check, ListTodo, Plus, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import {
  useWorkspaceTodoStore,
  useWorkspaceTodos,
  useWorkspaceTodoSummaryByKey,
  type WorkspaceTodoItem,
} from "@/todos/workspace-todo-store";
import type { Theme } from "@/styles/theme";

const ThemedListTodo = withUnistyles(ListTodo);
const ThemedCheck = withUnistyles(Check);
const ThemedPlus = withUnistyles(Plus);
const ThemedTrash2 = withUnistyles(Trash2);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const extraMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const whiteColorMapping = () => ({ color: "#ffffff" });
const dangerColorMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

export interface WorkspaceTodoPaneProps {
  serverId: string;
  workspaceId: string;
}

export const WorkspaceTodoPane = memo(function WorkspaceTodoPane({
  serverId,
  workspaceId,
}: WorkspaceTodoPaneProps): ReactElement {
  const { t } = useTranslation();
  const workspaceKey = useMemo(
    () => buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
    [serverId, workspaceId],
  );

  const todos = useWorkspaceTodos(workspaceKey);
  const summary = useWorkspaceTodoSummaryByKey(workspaceKey);
  const [hasText, setHasText] = useState(false);
  const [isAddFocused, setIsAddFocused] = useState(false);
  const inputRef = useRef<EditingTextInputHandle>(null);

  const handleTextChange = useCallback((text: string) => {
    setHasText(text.trim().length > 0);
  }, []);

  const handleAddTodo = useCallback(() => {
    if (!workspaceKey) return;
    const text = inputRef.current?.getText().trim() ?? "";
    if (!text) return;
    useWorkspaceTodoStore.getState().addTodo(workspaceKey, text);
    inputRef.current?.replaceText("");
    setHasText(false);
    inputRef.current?.focus();
  }, [workspaceKey]);

  const handleClearCompleted = useCallback(() => {
    if (!workspaceKey) return;
    useWorkspaceTodoStore.getState().clearCompleted(workspaceKey);
  }, [workspaceKey]);

  const handleFocusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  const handleAddFocus = useCallback(() => setIsAddFocused(true), []);
  const handleAddBlur = useCallback(() => setIsAddFocused(false), []);

  const progressStatus = useMemo(() => {
    if (!summary || summary.total === 0) return "empty";
    if (summary.completed === summary.total) return "done";
    if (summary.completed > 0) return "in_progress";
    return "open";
  }, [summary]);

  const badgeStyle = useMemo(() => {
    switch (progressStatus) {
      case "done":
        return styles.badgeDone;
      case "in_progress":
        return styles.badgeInProgress;
      default:
        return styles.badgeOpen;
    }
  }, [progressStatus]);

  const badgeTextStyle = useMemo(() => {
    switch (progressStatus) {
      case "done":
        return styles.badgeTextDone;
      case "in_progress":
        return styles.badgeTextInProgress;
      default:
        return styles.badgeTextOpen;
    }
  }, [progressStatus]);

  return (
    <View style={styles.container} testID="workspace-todo-pane">
      <View style={styles.toolbar} testID="workspace-todo-toolbar">
        <View style={styles.toolbarLeft}>
          <ThemedListTodo size={14} uniProps={mutedColorMapping} />
          <Text style={styles.toolbarTitle}>{t("panels.todo.label")}</Text>
          {summary && summary.total > 0 ? (
            <View style={[styles.badge, badgeStyle]} testID="workspace-todo-progress-badge">
              <Text style={[styles.badgeText, badgeTextStyle]}>
                {`${summary.completed}/${summary.total}`}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={styles.toolbarActions}>
          {summary && summary.completed > 0 ? (
            <Pressable
              style={styles.clearButton}
              accessibilityRole="button"
              accessibilityLabel={t("panels.todo.clearCompleted")}
              testID="workspace-todo-clear-completed"
              onPress={handleClearCompleted}
              hitSlop={8}
            >
              <ThemedTrash2 size={14} uniProps={extraMutedColorMapping} />
            </Pressable>
          ) : null}
        </View>
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {todos.length === 0 ? (
          <Pressable
            style={styles.emptyState}
            onPress={handleFocusInput}
            testID="workspace-todo-empty"
          >
            <View style={styles.emptyIconContainer}>
              <ThemedListTodo size={28} uniProps={extraMutedColorMapping} />
            </View>
            <Text style={styles.emptyTitle}>{t("panels.todo.emptyTitle")}</Text>
            <Text style={styles.emptyDescription}>{t("panels.todo.emptyDescription")}</Text>
          </Pressable>
        ) : (
          <View style={styles.todoList}>
            {todos.map((todo) => (
              <WorkspaceTodoRow key={todo.id} workspaceKey={workspaceKey ?? ""} todo={todo} />
            ))}
          </View>
        )}

        <View style={styles.addSection}>
          <View style={[styles.addInputContainer, isAddFocused && styles.addInputContainerFocused]}>
            <View style={styles.addIconSlot}>
              <ThemedPlus size={16} uniProps={extraMutedColorMapping} />
            </View>
            <TextInput
              ref={inputRef}
              style={styles.addInput}
              onChangeText={handleTextChange}
              onFocus={handleAddFocus}
              onBlur={handleAddBlur}
              placeholder={t("panels.todo.addPlaceholder")}
              placeholderTextColor={styles.placeholder.color}
              onSubmitEditing={handleAddTodo}
              returnKeyType="done"
              blurOnSubmit={false}
              testID="workspace-todo-add-input"
            />
            {hasText ? (
              <Pressable
                onPress={handleAddTodo}
                style={styles.addButton}
                testID="workspace-todo-add-button"
                accessibilityRole="button"
                accessibilityLabel={t("panels.todo.addPlaceholder")}
              >
                <Text style={styles.addButtonText}>Add</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </ScrollView>
    </View>
  );
});

interface WorkspaceTodoRowProps {
  workspaceKey: string;
  todo: WorkspaceTodoItem;
}

const WorkspaceTodoRow = memo(function WorkspaceTodoRow({
  workspaceKey,
  todo,
}: WorkspaceTodoRowProps): ReactElement {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const rowInputRef = useRef<EditingTextInputHandle>(null);

  const handleToggle = useCallback(() => {
    useWorkspaceTodoStore.getState().toggleTodo(workspaceKey, todo.id);
  }, [todo.id, workspaceKey]);

  const handleChangeText = useCallback(
    (newText: string) => {
      useWorkspaceTodoStore.getState().updateTodoText(workspaceKey, todo.id, newText);
    },
    [todo.id, workspaceKey],
  );

  const handleDelete = useCallback(() => {
    useWorkspaceTodoStore.getState().deleteTodo(workspaceKey, todo.id);
  }, [todo.id, workspaceKey]);

  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const currentText = rowInputRef.current?.getText() ?? "";
      if (event.nativeEvent.key === "Backspace" && currentText.length === 0) {
        handleDelete();
      }
    },
    [handleDelete],
  );

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const accessibilityState = useMemo(() => ({ checked: todo.completed }), [todo.completed]);

  return (
    <View
      style={[styles.row, isHovered && styles.rowHovered]}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID={`workspace-todo-row-${todo.id}`}
    >
      <Pressable
        onPress={handleToggle}
        style={[
          styles.checkbox,
          todo.completed ? styles.checkboxChecked : styles.checkboxUnchecked,
        ]}
        accessibilityRole="checkbox"
        accessibilityState={accessibilityState}
        accessibilityLabel={todo.text}
        testID={`workspace-todo-checkbox-${todo.id}`}
      >
        {todo.completed ? (
          <ThemedCheck size={11} strokeWidth={2.5} uniProps={whiteColorMapping} />
        ) : null}
      </Pressable>

      <TextInput
        ref={rowInputRef}
        style={[styles.todoInput, todo.completed && styles.todoInputCompleted]}
        initialValue={todo.text}
        onChangeText={handleChangeText}
        onKeyPress={handleKeyPress}
        multiline
        blurOnSubmit
        testID={`workspace-todo-text-${todo.id}`}
      />

      <Pressable
        onPress={handleDelete}
        style={[
          styles.deleteButton,
          isHovered ? styles.deleteButtonVisible : styles.deleteButtonHidden,
        ]}
        accessibilityRole="button"
        accessibilityLabel={t("panels.todo.deleteItem")}
        testID={`workspace-todo-delete-${todo.id}`}
        hitSlop={8}
      >
        <ThemedTrash2 size={14} uniProps={dangerColorMapping} />
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  toolbar: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.surfaceSidebar,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  toolbarLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  toolbarTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  badge: {
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 1,
    borderRadius: theme.borderRadius.full,
  },
  badgeOpen: {
    backgroundColor: theme.colors.surface2,
  },
  badgeInProgress: {
    backgroundColor: theme.colors.surface2,
  },
  badgeDone: {
    backgroundColor: theme.colors.surface2,
  },
  badgeText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 14,
  },
  badgeTextOpen: {
    color: theme.colors.foregroundMuted,
  },
  badgeTextInProgress: {
    color: theme.colors.statusWarning,
  },
  badgeTextDone: {
    color: theme.colors.statusSuccess,
  },
  toolbarActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  clearButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  scrollView: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  todoList: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: "transparent",
  },
  rowHovered: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 9,
    marginTop: 2,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  checkboxUnchecked: {
    borderWidth: 1.5,
    borderColor: theme.colors.foregroundExtraMuted,
    backgroundColor: "transparent",
  },
  checkboxChecked: {
    backgroundColor: theme.colors.accent,
  },
  todoInput: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
    color: theme.colors.foreground,
    padding: 0,
    margin: 0,
    // RN-web inputs keep the browser's default focus outline otherwise — the caret and the row
    // hover are the focus feedback, same as every other input in the app.
    outlineColor: "transparent",
    outlineWidth: 0,
  },
  todoInputCompleted: {
    color: theme.colors.foregroundMuted,
    textDecorationLine: "line-through",
  },
  deleteButton: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
    marginTop: 1,
  },
  deleteButtonVisible: {
    opacity: 1,
  },
  deleteButtonHidden: {
    opacity: 0,
  },
  addSection: {
    marginTop: theme.spacing[1],
  },
  addInputContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: "transparent",
    borderWidth: 0,
  },
  addInputContainerFocused: {
    backgroundColor: theme.colors.surface0,
  },
  addIconSlot: {
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  addInput: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    padding: 0,
    margin: 0,
    outlineColor: "transparent",
    outlineWidth: 0,
  },
  addButton: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  addButtonText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  emptyState: {
    paddingVertical: theme.spacing[8],
    paddingHorizontal: theme.spacing[4],
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  emptyIconContainer: {
    width: 48,
    height: 48,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.spacing[1],
  },
  emptyTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  emptyDescription: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    maxWidth: 240,
    lineHeight: 18,
  },
  placeholder: {
    color: theme.colors.foregroundExtraMuted,
  },
}));
