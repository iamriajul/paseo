// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { useWorkspaceTodoStore, useWorkspaceTodoSummary } from "@/todos/workspace-todo-store";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "ws-1";
const WORKSPACE_KEY = `${SERVER_ID}:${WORKSPACE_ID}`;

describe("WorkspaceTodoPill and useWorkspaceTodoSummary", () => {
  beforeEach(() => {
    useWorkspaceTodoStore.setState({ todosByWorkspace: {} });
  });

  it("returns null when workspace has no todos", () => {
    const { result } = renderHook(() => useWorkspaceTodoSummary(SERVER_ID, WORKSPACE_ID));
    expect(result.current).toBeNull();
  });

  it("returns summary when workspace has todos", () => {
    const { result } = renderHook(() => useWorkspaceTodoSummary(SERVER_ID, WORKSPACE_ID));

    act(() => {
      useWorkspaceTodoStore.getState().addTodo(WORKSPACE_KEY, "Task 1");
      useWorkspaceTodoStore.getState().addTodo(WORKSPACE_KEY, "Task 2");
    });

    expect(result.current).toEqual({
      total: 2,
      completed: 0,
    });

    const todos = useWorkspaceTodoStore.getState().getTodos(WORKSPACE_KEY);
    act(() => {
      useWorkspaceTodoStore.getState().toggleTodo(WORKSPACE_KEY, todos[0].id);
    });

    expect(result.current).toEqual({
      total: 2,
      completed: 1,
    });
  });
});
