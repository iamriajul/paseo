import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_UNPINNED_RECENT_FOLDERS, WorkspaceRecentFoldersStore } from "./store.js";

function at(minute: number): Date {
  return new Date(Date.UTC(2026, 10, 8, 12, minute));
}

describe("WorkspaceRecentFoldersStore", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "recent-folders-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("lists visits newest first and survives a restart", async () => {
    const store = new WorkspaceRecentFoldersStore(home);
    await store.update("ws-1", { action: "visit", path: "/tmp/a", now: at(1) });
    await store.update("ws-1", { action: "visit", path: "/tmp/b", now: at(2) });
    await store.update("ws-1", { action: "visit", path: "/tmp/a", now: at(3) });

    const reopened = new WorkspaceRecentFoldersStore(home);
    expect((await reopened.get("ws-1")).map((folder) => folder.path)).toEqual(["/tmp/a", "/tmp/b"]);
    expect(await reopened.get("ws-2")).toEqual([]);
  });

  it("keeps pinned folders on top and outside the cap", async () => {
    const store = new WorkspaceRecentFoldersStore(home);
    await store.update("ws-1", { action: "visit", path: "/pinned", now: at(0) });
    await store.update("ws-1", { action: "pin", path: "/pinned" });
    for (let index = 1; index <= MAX_UNPINNED_RECENT_FOLDERS + 2; index += 1) {
      await store.update("ws-1", { action: "visit", path: `/f${index}`, now: at(index) });
    }

    const folders = await store.get("ws-1");
    expect(folders[0]).toMatchObject({ path: "/pinned", pinned: true });
    expect(folders.filter((folder) => !folder.pinned)).toHaveLength(MAX_UNPINNED_RECENT_FOLDERS);
    expect(folders.map((folder) => folder.path)).not.toContain("/f1");
    expect(folders[1].path).toBe(`/f${MAX_UNPINNED_RECENT_FOLDERS + 2}`);
  });

  it("removes and unpins, and a visit keeps a pin", async () => {
    const store = new WorkspaceRecentFoldersStore(home);
    await store.update("ws-1", { action: "visit", path: "/a", now: at(1) });
    await store.update("ws-1", { action: "visit", path: "/b", now: at(2) });
    await store.update("ws-1", { action: "pin", path: "/a" });
    await store.update("ws-1", { action: "visit", path: "/a", now: at(3) });
    expect(await store.get("ws-1")).toEqual([
      { path: "/a", pinned: true, visitedAt: at(3).toISOString() },
      { path: "/b", pinned: false, visitedAt: at(2).toISOString() },
    ]);

    await store.update("ws-1", { action: "unpin", path: "/a" });
    await store.update("ws-1", { action: "remove", path: "/b" });
    expect(await store.get("ws-1")).toEqual([
      { path: "/a", pinned: false, visitedAt: at(3).toISOString() },
    ]);
  });

  it("applies concurrent updates from two devices without losing either", async () => {
    const store = new WorkspaceRecentFoldersStore(home);
    await Promise.all([
      store.update("ws-1", { action: "visit", path: "/phone", now: at(1) }),
      store.update("ws-1", { action: "visit", path: "/desktop", now: at(2) }),
    ]);
    expect((await store.get("ws-1")).map((folder) => folder.path)).toEqual(["/desktop", "/phone"]);
  });
});
