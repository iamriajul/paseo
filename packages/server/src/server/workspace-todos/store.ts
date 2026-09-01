import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { WorkspaceTodoItemSchema, type WorkspaceTodoItem } from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../atomic-file.js";

const StoredWorkspaceTodosPayloadSchema = z.object({
  todosByWorkspace: z.record(z.string(), z.array(WorkspaceTodoItemSchema)).optional(),
});

type StoredWorkspaceTodosPayload = z.infer<typeof StoredWorkspaceTodosPayloadSchema>;

const EMPTY_TODOS: WorkspaceTodoItem[] = [];

export class WorkspaceTodoStore {
  private readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(paseoHome: string) {
    this.filePath = join(paseoHome, "projects", "workspace-todos.json");
  }

  async get(workspaceId: string): Promise<WorkspaceTodoItem[]> {
    const key = workspaceId.trim();
    if (!key) return EMPTY_TODOS;
    const payload = await this.read();
    return payload.todosByWorkspace?.[key] ?? EMPTY_TODOS;
  }

  async set(workspaceId: string, todos: WorkspaceTodoItem[]): Promise<WorkspaceTodoItem[]> {
    const key = workspaceId.trim();
    if (!key) return EMPTY_TODOS;

    return this.mutate(async (payload) => {
      const current = payload.todosByWorkspace ?? {};
      const next = { ...current };

      if (todos.length === 0) {
        delete next[key];
      } else {
        next[key] = todos.map((t) => WorkspaceTodoItemSchema.parse(t));
      }

      return {
        payload: { todosByWorkspace: next },
        result: next[key] ?? EMPTY_TODOS,
      };
    });
  }

  async listAll(): Promise<Record<string, WorkspaceTodoItem[]>> {
    const payload = await this.read();
    return payload.todosByWorkspace ?? {};
  }

  private async read(): Promise<StoredWorkspaceTodosPayload> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8"));
      return StoredWorkspaceTodosPayloadSchema.parse(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { todosByWorkspace: {} };
      }
      throw error;
    }
  }

  private async persist(payload: StoredWorkspaceTodosPayload): Promise<void> {
    await writeJsonFileAtomic(this.filePath, payload);
  }

  private mutate<T>(
    fn: (payload: StoredWorkspaceTodosPayload) => Promise<{
      payload: StoredWorkspaceTodosPayload;
      result: T;
    }>,
  ): Promise<T> {
    const next = this.queue.then(async () => {
      const current = await this.read();
      const outcome = await fn(current);
      await this.persist(outcome.payload);
      return outcome.result;
    });
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
