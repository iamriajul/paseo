import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceTodoStore } from "./store.js";
import type { WorkspaceTodoItem } from "@getpaseo/protocol/messages";

describe("WorkspaceTodoStore", () => {
  let paseoHome: string;
  let store: WorkspaceTodoStore;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "paseo-todo-store-test-"));
    store = new WorkspaceTodoStore(paseoHome);
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  it("returns empty array for non-existent workspace", async () => {
    const todos = await store.get("ws_1");
    expect(todos).toEqual([]);
  });

  it("stores and retrieves workspace todos", async () => {
    const items: WorkspaceTodoItem[] = [
      { id: "1", text: "Buy milk", completed: false, createdAt: 100 },
      { id: "2", text: "Ship feature", completed: true, createdAt: 200, completedAt: 250 },
    ];

    await store.set("ws_1", items);
    const result = await store.get("ws_1");
    expect(result).toEqual(items);
  });

  it("isolates todos between different workspaces", async () => {
    const ws1Items: WorkspaceTodoItem[] = [
      { id: "1", text: "WS1 task", completed: false, createdAt: 100 },
    ];
    const ws2Items: WorkspaceTodoItem[] = [
      { id: "2", text: "WS2 task", completed: true, createdAt: 200 },
    ];

    await store.set("ws_1", ws1Items);
    await store.set("ws_2", ws2Items);

    expect(await store.get("ws_1")).toEqual(ws1Items);
    expect(await store.get("ws_2")).toEqual(ws2Items);
  });

  it("clears workspace entry when set to empty array", async () => {
    const items: WorkspaceTodoItem[] = [
      { id: "1", text: "Task", completed: false, createdAt: 100 },
    ];
    await store.set("ws_1", items);
    expect(await store.get("ws_1")).toHaveLength(1);

    await store.set("ws_1", []);
    expect(await store.get("ws_1")).toEqual([]);
    expect(await store.listAll()).toEqual({});
  });
});
