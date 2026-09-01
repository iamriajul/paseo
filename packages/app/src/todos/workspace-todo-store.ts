import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

export interface WorkspaceTodoItem {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
  completedAt?: number | null;
}

export interface WorkspaceTodoSummary {
  total: number;
  completed: number;
}

export interface WorkspaceTodoStoreState {
  todosByWorkspace: Record<string, WorkspaceTodoItem[]>;
  getTodos: (workspaceKey: string) => WorkspaceTodoItem[];
  addTodo: (workspaceKey: string, text: string) => WorkspaceTodoItem | null;
  toggleTodo: (workspaceKey: string, id: string) => void;
  updateTodoText: (workspaceKey: string, id: string, text: string) => void;
  deleteTodo: (workspaceKey: string, id: string) => void;
  reorderTodos: (workspaceKey: string, todoIds: string[]) => void;
  clearCompleted: (workspaceKey: string) => void;
  setTodos: (workspaceKey: string, todos: WorkspaceTodoItem[]) => void;
}

export const WorkspaceTodoItemSchema = z.strictObject({
  id: z.string(),
  text: z.string(),
  completed: z.boolean(),
  createdAt: z.number(),
  completedAt: z.number().nullable().optional(),
});

export const WorkspaceTodoPersistedStateSchema = z.strictObject({
  todosByWorkspace: z.record(z.string(), z.array(WorkspaceTodoItemSchema)).optional(),
});

type WorkspaceTodoPersistedState = z.infer<typeof WorkspaceTodoPersistedStateSchema>;

const EMPTY_TODOS: WorkspaceTodoItem[] = [];

function generateTodoId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `todo_${timestamp}_${random}`;
}

export function parseWorkspacePersistenceKey(
  workspaceKey: string,
): { serverId: string; workspaceId: string } | null {
  const index = workspaceKey.indexOf(":");
  if (index < 0) return null;
  const serverId = workspaceKey.slice(0, index).trim();
  const workspaceId = workspaceKey.slice(index + 1).trim();
  if (!serverId || !workspaceId) return null;
  return { serverId, workspaceId };
}

function syncToDaemon(workspaceKey: string, todos: WorkspaceTodoItem[]): void {
  const parsed = parseWorkspacePersistenceKey(workspaceKey);
  if (!parsed) return;
  try {
    const client = getHostRuntimeStore().getClient(parsed.serverId);
    if (client) {
      void client.setWorkspaceTodos(parsed.workspaceId, todos).catch(() => undefined);
    }
  } catch {
    // Client unavailable or test environment without runtime store
  }
}

export async function fetchWorkspaceTodos(serverId: string, workspaceId: string): Promise<void> {
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  if (!workspaceKey) return;
  try {
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) return;
    const { todos } = await client.getWorkspaceTodos(workspaceId);
    useWorkspaceTodoStore.getState().setTodos(workspaceKey, todos);
  } catch {
    // Keep local cache if offline or daemon call fails
  }
}

export function selectWorkspaceTodos(
  state: WorkspaceTodoStoreState,
  workspaceKey: string | null | undefined,
): WorkspaceTodoItem[] {
  if (!workspaceKey) return EMPTY_TODOS;
  return state.todosByWorkspace[workspaceKey] ?? EMPTY_TODOS;
}

export function selectWorkspaceTodoSummary(
  state: WorkspaceTodoStoreState,
  workspaceKey: string | null | undefined,
): WorkspaceTodoSummary | null {
  if (!workspaceKey) return null;
  const items = state.todosByWorkspace[workspaceKey];
  if (!items || items.length === 0) return null;
  let completed = 0;
  for (const item of items) {
    if (item.completed) {
      completed += 1;
    }
  }
  return {
    total: items.length,
    completed,
  };
}

export function migrateWorkspaceTodoState(persistedState: unknown): {
  todosByWorkspace: Record<string, WorkspaceTodoItem[]>;
} {
  const parsed = WorkspaceTodoPersistedStateSchema.safeParse(persistedState);
  if (!parsed.success || !parsed.data.todosByWorkspace) {
    return { todosByWorkspace: {} };
  }
  return { todosByWorkspace: parsed.data.todosByWorkspace };
}

export const useWorkspaceTodoStore = create<WorkspaceTodoStoreState>()(
  persist(
    (set, get) => ({
      todosByWorkspace: {},
      getTodos: (workspaceKey: string) => {
        const key = workspaceKey.trim();
        if (!key) return EMPTY_TODOS;
        return get().todosByWorkspace[key] ?? EMPTY_TODOS;
      },
      addTodo: (workspaceKey: string, text: string) => {
        const key = workspaceKey.trim();
        const trimmedText = text.trim();
        if (!key || !trimmedText) return null;

        const newItem: WorkspaceTodoItem = {
          id: generateTodoId(),
          text: trimmedText,
          completed: false,
          createdAt: Date.now(),
          completedAt: null,
        };

        let nextTodos: WorkspaceTodoItem[] = [];
        set((state) => {
          const current = state.todosByWorkspace[key] ?? [];
          nextTodos = [...current, newItem];
          return {
            todosByWorkspace: {
              ...state.todosByWorkspace,
              [key]: nextTodos,
            },
          };
        });

        syncToDaemon(key, nextTodos);
        return newItem;
      },
      toggleTodo: (workspaceKey: string, id: string) => {
        const key = workspaceKey.trim();
        if (!key || !id) return;

        let nextTodos: WorkspaceTodoItem[] = [];
        set((state) => {
          const current = state.todosByWorkspace[key];
          if (!current) return state;
          nextTodos = current.map((item) => {
            if (item.id !== id) return item;
            const nextCompleted = !item.completed;
            return Object.assign({}, item, {
              completed: nextCompleted,
              completedAt: nextCompleted ? Date.now() : null,
            });
          });
          return {
            todosByWorkspace: {
              ...state.todosByWorkspace,
              [key]: nextTodos,
            },
          };
        });

        if (nextTodos.length > 0) {
          syncToDaemon(key, nextTodos);
        }
      },
      updateTodoText: (workspaceKey: string, id: string, text: string) => {
        const key = workspaceKey.trim();
        if (!key || !id) return;

        let nextTodos: WorkspaceTodoItem[] = [];
        set((state) => {
          const current = state.todosByWorkspace[key];
          if (!current) return state;
          nextTodos = current.map((item) =>
            item.id === id ? Object.assign({}, item, { text }) : item,
          );
          return {
            todosByWorkspace: {
              ...state.todosByWorkspace,
              [key]: nextTodos,
            },
          };
        });

        if (nextTodos.length > 0) {
          syncToDaemon(key, nextTodos);
        }
      },
      deleteTodo: (workspaceKey: string, id: string) => {
        const key = workspaceKey.trim();
        if (!key || !id) return;

        let nextTodos: WorkspaceTodoItem[] = [];
        set((state) => {
          const current = state.todosByWorkspace[key];
          if (!current) return state;
          nextTodos = current.filter((item) => item.id !== id);
          if (nextTodos.length === 0) {
            const copy = { ...state.todosByWorkspace };
            delete copy[key];
            return { todosByWorkspace: copy };
          }
          return {
            todosByWorkspace: {
              ...state.todosByWorkspace,
              [key]: nextTodos,
            },
          };
        });

        syncToDaemon(key, nextTodos);
      },
      reorderTodos: (workspaceKey: string, todoIds: string[]) => {
        const key = workspaceKey.trim();
        if (!key) return;

        let nextTodos: WorkspaceTodoItem[] = [];
        set((state) => {
          const current = state.todosByWorkspace[key];
          if (!current) return state;
          const byId = new Map(current.map((item) => [item.id, item]));
          const next: WorkspaceTodoItem[] = [];
          for (const id of todoIds) {
            const item = byId.get(id);
            if (item) {
              next.push(item);
              byId.delete(id);
            }
          }
          for (const remaining of byId.values()) {
            next.push(remaining);
          }
          nextTodos = next;
          return {
            todosByWorkspace: {
              ...state.todosByWorkspace,
              [key]: next,
            },
          };
        });

        if (nextTodos.length > 0) {
          syncToDaemon(key, nextTodos);
        }
      },
      clearCompleted: (workspaceKey: string) => {
        const key = workspaceKey.trim();
        if (!key) return;

        let nextTodos: WorkspaceTodoItem[] = [];
        set((state) => {
          const current = state.todosByWorkspace[key];
          if (!current) return state;
          nextTodos = current.filter((item) => !item.completed);
          if (nextTodos.length === 0) {
            const copy = { ...state.todosByWorkspace };
            delete copy[key];
            return { todosByWorkspace: copy };
          }
          return {
            todosByWorkspace: {
              ...state.todosByWorkspace,
              [key]: nextTodos,
            },
          };
        });

        syncToDaemon(key, nextTodos);
      },
      setTodos: (workspaceKey: string, todos: WorkspaceTodoItem[]) => {
        const key = workspaceKey.trim();
        if (!key) return;
        set((state) => {
          if (todos.length === 0) {
            const copy = { ...state.todosByWorkspace };
            delete copy[key];
            return { todosByWorkspace: copy };
          }
          return {
            todosByWorkspace: {
              ...state.todosByWorkspace,
              [key]: todos,
            },
          };
        });
      },
    }),
    {
      name: "workspace-todos",
      storage: createValidatedPersistStorage<WorkspaceTodoPersistedState>(
        AsyncStorage,
        WorkspaceTodoPersistedStateSchema,
      ),
      partialize: (state) => ({
        todosByWorkspace: state.todosByWorkspace,
      }),
      version: 1,
      migrate: migrateWorkspaceTodoState,
    },
  ),
);

export function useWorkspaceTodos(workspaceKey: string | null | undefined): WorkspaceTodoItem[] {
  const selector = useCallback(
    (state: WorkspaceTodoStoreState) => selectWorkspaceTodos(state, workspaceKey),
    [workspaceKey],
  );

  useEffect(() => {
    if (!workspaceKey) return;
    const parsed = parseWorkspacePersistenceKey(workspaceKey);
    if (parsed) {
      void fetchWorkspaceTodos(parsed.serverId, parsed.workspaceId);
    }
  }, [workspaceKey]);

  return useStoreWithEqualityFn(useWorkspaceTodoStore, selector);
}

export function useWorkspaceTodoSummary(
  serverId: string | null | undefined,
  workspaceId: string | null | undefined,
): WorkspaceTodoSummary | null {
  const workspaceKey =
    serverId && workspaceId ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId }) : null;
  return useWorkspaceTodoSummaryByKey(workspaceKey);
}

export function useWorkspaceTodoSummaryByKey(
  workspaceKey: string | null | undefined,
): WorkspaceTodoSummary | null {
  const selector = useCallback(
    (state: WorkspaceTodoStoreState) => selectWorkspaceTodoSummary(state, workspaceKey),
    [workspaceKey],
  );

  useEffect(() => {
    if (!workspaceKey) return;
    const parsed = parseWorkspacePersistenceKey(workspaceKey);
    if (parsed) {
      void fetchWorkspaceTodos(parsed.serverId, parsed.workspaceId);
    }
  }, [workspaceKey]);

  return useStoreWithEqualityFn(
    useWorkspaceTodoStore,
    selector,
    (a, b) => a?.total === b?.total && a?.completed === b?.completed,
  );
}
