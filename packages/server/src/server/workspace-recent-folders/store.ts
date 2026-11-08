import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  WorkspaceRecentFolderSchema,
  type WorkspaceRecentFolder,
  type WorkspaceRecentFolderAction,
} from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../atomic-file.js";

/** Unpinned folders beyond this are dropped, oldest first. Pinned folders never count. */
export const MAX_UNPINNED_RECENT_FOLDERS = 10;

const StoredRecentFoldersSchema = z.object({
  foldersByWorkspace: z.record(z.string(), z.array(WorkspaceRecentFolderSchema)).optional(),
});
type StoredRecentFolders = z.infer<typeof StoredRecentFoldersSchema>;

export interface RecentFolderUpdate {
  action: WorkspaceRecentFolderAction;
  path: string;
  now?: Date;
}

/**
 * The Files panel's Recent group, per workspace. Clients send one action at a time rather than
 * the whole list, so a phone and a desktop changing it at once both land.
 */
export class WorkspaceRecentFoldersStore {
  private readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(paseoHome: string) {
    this.filePath = join(paseoHome, "projects", "workspace-recent-folders.json");
  }

  async get(workspaceId: string): Promise<WorkspaceRecentFolder[]> {
    const key = workspaceId.trim();
    if (!key) return [];
    const stored = await this.read();
    return stored.foldersByWorkspace?.[key] ?? [];
  }

  async update(workspaceId: string, update: RecentFolderUpdate): Promise<WorkspaceRecentFolder[]> {
    const key = workspaceId.trim();
    const path = update.path.trim();
    if (!key) throw new Error("workspaceId is required");
    if (!path) throw new Error("path is required");
    return this.mutate((stored) => {
      const current = stored.foldersByWorkspace?.[key] ?? [];
      const next = applyRecentFolderUpdate(current, { ...update, path });
      const foldersByWorkspace = { ...stored.foldersByWorkspace };
      if (next.length === 0) delete foldersByWorkspace[key];
      else foldersByWorkspace[key] = next;
      return { stored: { foldersByWorkspace }, result: next };
    });
  }

  private async read(): Promise<StoredRecentFolders> {
    try {
      return StoredRecentFoldersSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private mutate<T>(
    fn: (stored: StoredRecentFolders) => { stored: StoredRecentFolders; result: T },
  ): Promise<T> {
    const next = this.queue.then(async () => {
      const outcome = fn(await this.read());
      await writeJsonFileAtomic(this.filePath, outcome.stored);
      return outcome.result;
    });
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** Pinned first, then newest visit first; unpinned capped at {@link MAX_UNPINNED_RECENT_FOLDERS}. */
export function applyRecentFolderUpdate(
  folders: readonly WorkspaceRecentFolder[],
  update: RecentFolderUpdate,
): WorkspaceRecentFolder[] {
  const existing = folders.find((folder) => folder.path === update.path);
  const others = folders.filter((folder) => folder.path !== update.path);
  let next: WorkspaceRecentFolder[];
  switch (update.action) {
    case "visit":
      next = [
        {
          path: update.path,
          pinned: existing?.pinned ?? false,
          visitedAt: (update.now ?? new Date()).toISOString(),
        },
        ...others,
      ];
      break;
    case "pin":
    case "unpin":
      if (!existing) return [...folders];
      next = [{ ...existing, pinned: update.action === "pin" }, ...others];
      break;
    case "remove":
      next = others;
      break;
  }
  next.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.visitedAt.localeCompare(a.visitedAt);
  });
  let unpinned = 0;
  return next.filter((folder) => folder.pinned || ++unpinned <= MAX_UNPINNED_RECENT_FOLDERS);
}
