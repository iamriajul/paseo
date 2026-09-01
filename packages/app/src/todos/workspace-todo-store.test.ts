import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import {
  fetchWorkspaceTodos,
  migrateWorkspaceTodoState,
  selectWorkspaceTodos,
  selectWorkspaceTodoSummary,
  useWorkspaceTodoStore,
} from "./workspace-todo-store";

vi.mock("@/runtime/host-runtime", () => {
  const client = {
    getWorkspaceTodos: vi.fn(async () => ({
      todos: [{ id: "daemon-1", text: "Synced task", completed: true, createdAt: 1 }],
    })),
    setWorkspaceTodos: vi.fn(async () => ({ todos: [] })),
  };
  return {
    getHostRuntimeStore: () => ({
      getClient: () => client,
    }),
  };
});

const WS_1 = "server-1:ws-1";
const WS_2 = "server-1:ws-2";

beforeEach(() => {
  useWorkspaceTodoStore.setState({ todosByWorkspace: {} });
});

describe("workspace-todo-store", () => {
  it("adds a todo to a workspace", () => {
    const item = useWorkspaceTodoStore.getState().addTodo(WS_1, "Buy groceries");
    expect(item).not.toBeNull();
    expect(item?.text).toBe("Buy groceries");
    expect(item?.completed).toBe(false);

    const todos = useWorkspaceTodoStore.getState().getTodos(WS_1);
    expect(todos).toHaveLength(1);
    expect(todos[0].text).toBe("Buy groceries");
    expect(selectWorkspaceTodos(useWorkspaceTodoStore.getState(), WS_1)).toEqual(todos);
  });

  it("does not add empty or whitespace-only todos", () => {
    const item1 = useWorkspaceTodoStore.getState().addTodo(WS_1, "");
    const item2 = useWorkspaceTodoStore.getState().addTodo(WS_1, "   ");
    expect(item1).toBeNull();
    expect(item2).toBeNull();
    expect(useWorkspaceTodoStore.getState().getTodos(WS_1)).toHaveLength(0);
  });

  it("toggles todo completion status", () => {
    const item = useWorkspaceTodoStore.getState().addTodo(WS_1, "Write tests")!;
    expect(item.completed).toBe(false);

    useWorkspaceTodoStore.getState().toggleTodo(WS_1, item.id);
    let todos = useWorkspaceTodoStore.getState().getTodos(WS_1);
    expect(todos[0].completed).toBe(true);
    expect(todos[0].completedAt).toBeTypeOf("number");

    useWorkspaceTodoStore.getState().toggleTodo(WS_1, item.id);
    todos = useWorkspaceTodoStore.getState().getTodos(WS_1);
    expect(todos[0].completed).toBe(false);
    expect(todos[0].completedAt).toBeNull();
  });

  it("updates todo text", () => {
    const item = useWorkspaceTodoStore.getState().addTodo(WS_1, "Initial task")!;
    useWorkspaceTodoStore.getState().updateTodoText(WS_1, item.id, "Updated task description");

    const todos = useWorkspaceTodoStore.getState().getTodos(WS_1);
    expect(todos[0].text).toBe("Updated task description");
  });

  it("deletes a todo item", () => {
    const item1 = useWorkspaceTodoStore.getState().addTodo(WS_1, "Task 1")!;
    const item2 = useWorkspaceTodoStore.getState().addTodo(WS_1, "Task 2")!;

    useWorkspaceTodoStore.getState().deleteTodo(WS_1, item1.id);
    const todos = useWorkspaceTodoStore.getState().getTodos(WS_1);
    expect(todos).toHaveLength(1);
    expect(todos[0].id).toBe(item2.id);

    useWorkspaceTodoStore.getState().deleteTodo(WS_1, item2.id);
    expect(useWorkspaceTodoStore.getState().getTodos(WS_1)).toHaveLength(0);
    expect(useWorkspaceTodoStore.getState().todosByWorkspace[WS_1]).toBeUndefined();
  });

  it("reorders todos", () => {
    const item1 = useWorkspaceTodoStore.getState().addTodo(WS_1, "Task 1")!;
    const item2 = useWorkspaceTodoStore.getState().addTodo(WS_1, "Task 2")!;
    const item3 = useWorkspaceTodoStore.getState().addTodo(WS_1, "Task 3")!;

    useWorkspaceTodoStore.getState().reorderTodos(WS_1, [item3.id, item1.id, item2.id]);
    const todos = useWorkspaceTodoStore.getState().getTodos(WS_1);
    expect(todos.map((t) => t.id)).toEqual([item3.id, item1.id, item2.id]);
  });

  it("clears completed todos", () => {
    const item1 = useWorkspaceTodoStore.getState().addTodo(WS_1, "Task 1")!;
    const item2 = useWorkspaceTodoStore.getState().addTodo(WS_1, "Task 2")!;
    useWorkspaceTodoStore.getState().toggleTodo(WS_1, item1.id);

    useWorkspaceTodoStore.getState().clearCompleted(WS_1);
    const todos = useWorkspaceTodoStore.getState().getTodos(WS_1);
    expect(todos).toHaveLength(1);
    expect(todos[0].id).toBe(item2.id);
  });

  it("keeps todos scoped per workspace", () => {
    useWorkspaceTodoStore.getState().addTodo(WS_1, "Workspace 1 Task");
    useWorkspaceTodoStore.getState().addTodo(WS_2, "Workspace 2 Task A");
    useWorkspaceTodoStore.getState().addTodo(WS_2, "Workspace 2 Task B");

    expect(useWorkspaceTodoStore.getState().getTodos(WS_1)).toHaveLength(1);
    expect(useWorkspaceTodoStore.getState().getTodos(WS_2)).toHaveLength(2);
  });

  it("calculates summary correctly", () => {
    const state = useWorkspaceTodoStore.getState();
    expect(selectWorkspaceTodoSummary(state, WS_1)).toBeNull();

    const item1 = state.addTodo(WS_1, "Task 1")!;
    state.addTodo(WS_1, "Task 2");
    state.addTodo(WS_1, "Task 3");

    let current = useWorkspaceTodoStore.getState();
    expect(selectWorkspaceTodoSummary(current, WS_1)).toEqual({
      total: 3,
      completed: 0,
    });

    current.toggleTodo(WS_1, item1.id);
    current = useWorkspaceTodoStore.getState();
    expect(selectWorkspaceTodoSummary(current, WS_1)).toEqual({
      total: 3,
      completed: 1,
    });
  });

  it("fetches and syncs todos from daemon client", async () => {
    await fetchWorkspaceTodos("server-1", "ws-1");
    const todos = useWorkspaceTodoStore.getState().getTodos("server-1:ws-1");
    expect(todos).toHaveLength(1);
    expect(todos[0].id).toBe("daemon-1");
    expect(todos[0].text).toBe("Synced task");
  });

  it("updates state when setTodos is called from broadcast update", () => {
    useWorkspaceTodoStore
      .getState()
      .setTodos(WS_1, [
        { id: "device2-1", text: "Created on other device", completed: false, createdAt: 5000 },
      ]);
    const todos = useWorkspaceTodoStore.getState().getTodos(WS_1);
    expect(todos).toHaveLength(1);
    expect(todos[0].id).toBe("device2-1");
    expect(todos[0].text).toBe("Created on other device");

    useWorkspaceTodoStore.getState().setTodos(WS_1, []);
    expect(useWorkspaceTodoStore.getState().getTodos(WS_1)).toHaveLength(0);
    expect(useWorkspaceTodoStore.getState().todosByWorkspace[WS_1]).toBeUndefined();
  });

  it("migrates persisted state properly", () => {
    const valid = {
      todosByWorkspace: {
        [WS_1]: [
          { id: "1", text: "Do this", completed: false, createdAt: 12345, completedAt: null },
        ],
      },
    };
    expect(migrateWorkspaceTodoState(valid)).toEqual(valid);

    expect(migrateWorkspaceTodoState(null)).toEqual({ todosByWorkspace: {} });
    expect(migrateWorkspaceTodoState({ invalid: "data" })).toEqual({ todosByWorkspace: {} });
  });
});
