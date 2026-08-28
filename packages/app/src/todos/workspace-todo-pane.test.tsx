/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditingTextInputHandle } from "@/components/ui/text-input";

vi.mock("react-native", () => ({
  Platform: {
    OS: "web",
    select: (map: Record<string, unknown>) => map.web ?? map.default ?? map.ios,
  },
  View: ({
    children,
    testID,
    ...props
  }: React.PropsWithChildren<{ testID?: string } & Record<string, unknown>>) =>
    React.createElement("div", { "data-testid": testID, ...props }, children),
  Text: ({
    children,
    testID,
    ...props
  }: React.PropsWithChildren<{ testID?: string } & Record<string, unknown>>) =>
    React.createElement("span", { "data-testid": testID, ...props }, children),
  Pressable: ({
    children,
    onPress,
    testID,
    ...props
  }: React.PropsWithChildren<
    { onPress?: () => void; testID?: string } & Record<string, unknown>
  >) =>
    React.createElement(
      "button",
      {
        type: "button",
        "data-testid": testID,
        onClick: onPress,
        ...props,
      },
      typeof children === "function"
        ? (children as (s: { hovered: boolean; pressed: boolean }) => React.ReactNode)({
            hovered: false,
            pressed: false,
          })
        : children,
    ),
  ScrollView: ({
    children,
    testID,
    ...props
  }: React.PropsWithChildren<{ testID?: string } & Record<string, unknown>>) =>
    React.createElement("div", { "data-testid": testID, ...props }, children),
}));

vi.mock("@/components/ui/text-input", () => ({
  EditingTextInput: React.forwardRef(function MockTextInput(
    { initialValue = "", onChangeText, onSubmitEditing, testID, ...props }: Record<string, unknown>,
    ref: React.Ref<EditingTextInputHandle>,
  ) {
    const [val, setVal] = React.useState(initialValue as string);
    const inputRef = React.useRef<HTMLInputElement>(null);

    React.useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
      blur: () => inputRef.current?.blur(),
      isFocused: () => document.activeElement === inputRef.current,
      getText: () => val,
      replaceText: (nextText: string) => {
        setVal(nextText);
        (onChangeText as ((text: string) => void) | undefined)?.(nextText);
      },
      getNativeRef: () => inputRef.current,
    }));

    return React.createElement("input", {
      ref: inputRef,
      "data-testid": testID,
      value: val,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        setVal(e.target.value);
        (onChangeText as ((text: string) => void) | undefined)?.(e.target.value);
      },
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") (onSubmitEditing as (() => void) | undefined)?.();
      },
      ...props,
    });
  }),
}));

vi.mock("lucide-react-native", () => ({
  ListTodo: (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": "ListTodo" }),
  Check: (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": "Check" }),
  Plus: (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": "Plus" }),
  Trash2: (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": "Trash2" }),
}));

import { theme } from "@/styles/theme";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) => (props: Record<string, unknown>) =>
      React.createElement(Component, props),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { useWorkspaceTodoStore } from "./workspace-todo-store";
import { WorkspaceTodoPane } from "./workspace-todo-pane";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "ws-test";
const WORKSPACE_KEY = `${SERVER_ID}:${WORKSPACE_ID}`;

describe("WorkspaceTodoPane", () => {
  beforeEach(() => {
    useWorkspaceTodoStore.setState({ todosByWorkspace: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders empty state when no todos exist", () => {
    render(<WorkspaceTodoPane serverId={SERVER_ID} workspaceId={WORKSPACE_ID} />);

    expect(screen.getByTestId("workspace-todo-empty")).toBeTruthy();
    expect(screen.getByTestId("workspace-todo-add-input")).toBeTruthy();
  });

  it("adds a todo item on typing and submitting", () => {
    render(<WorkspaceTodoPane serverId={SERVER_ID} workspaceId={WORKSPACE_ID} />);

    const input = screen.getByTestId("workspace-todo-add-input");
    act(() => {
      fireEvent.change(input, { target: { value: "Review pull request" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });

    const todos = useWorkspaceTodoStore.getState().getTodos(WORKSPACE_KEY);
    expect(todos).toHaveLength(1);
    expect(todos[0].text).toBe("Review pull request");
    expect(todos[0].completed).toBe(false);

    expect(screen.getByTestId(`workspace-todo-row-${todos[0].id}`)).toBeTruthy();
    expect(screen.getByTestId("workspace-todo-progress-badge")).toBeTruthy();
  });

  it("toggles a todo checkbox", () => {
    act(() => {
      useWorkspaceTodoStore.getState().addTodo(WORKSPACE_KEY, "Deploy to staging");
    });
    const todo = useWorkspaceTodoStore.getState().getTodos(WORKSPACE_KEY)[0];

    render(<WorkspaceTodoPane serverId={SERVER_ID} workspaceId={WORKSPACE_ID} />);

    const checkbox = screen.getByTestId(`workspace-todo-checkbox-${todo.id}`);
    act(() => {
      fireEvent.click(checkbox);
    });

    expect(useWorkspaceTodoStore.getState().getTodos(WORKSPACE_KEY)[0].completed).toBe(true);

    act(() => {
      fireEvent.click(checkbox);
    });
    expect(useWorkspaceTodoStore.getState().getTodos(WORKSPACE_KEY)[0].completed).toBe(false);
  });

  it("deletes a todo item", () => {
    act(() => {
      useWorkspaceTodoStore.getState().addTodo(WORKSPACE_KEY, "Clean up logs");
    });
    const todo = useWorkspaceTodoStore.getState().getTodos(WORKSPACE_KEY)[0];

    render(<WorkspaceTodoPane serverId={SERVER_ID} workspaceId={WORKSPACE_ID} />);

    const deleteBtn = screen.getByTestId(`workspace-todo-delete-${todo.id}`);
    act(() => {
      fireEvent.click(deleteBtn);
    });

    expect(useWorkspaceTodoStore.getState().getTodos(WORKSPACE_KEY)).toHaveLength(0);
  });

  it("clears completed todos when clicking clear completed", () => {
    act(() => {
      useWorkspaceTodoStore.getState().addTodo(WORKSPACE_KEY, "Task 1");
      useWorkspaceTodoStore.getState().addTodo(WORKSPACE_KEY, "Task 2");
      const todos = useWorkspaceTodoStore.getState().getTodos(WORKSPACE_KEY);
      useWorkspaceTodoStore.getState().toggleTodo(WORKSPACE_KEY, todos[0].id);
    });
    const todos = useWorkspaceTodoStore.getState().getTodos(WORKSPACE_KEY);

    render(<WorkspaceTodoPane serverId={SERVER_ID} workspaceId={WORKSPACE_ID} />);

    const clearBtn = screen.getByTestId("workspace-todo-clear-completed");
    act(() => {
      fireEvent.click(clearBtn);
    });

    const remaining = useWorkspaceTodoStore.getState().getTodos(WORKSPACE_KEY);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(todos[1].id);
  });
});
