import type { Agent } from "@/stores/session-store";
import { isAbsolutePath } from "@/utils/path";

export type FilesViewMode = "list" | "grid";
export type FilesGridSize = "small" | "medium" | "large";

/** Images the daemon can thumbnail; anything else in the grid shows its file-type icon. */
const THUMBNAIL_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp"]);
/** A folder this image-heavy opens as a grid the first time it is seen. */
export const GRID_DEFAULT_IMAGE_SHARE = 0.7;

export const FILES_GRID_TILE_EDGE: Record<FilesGridSize, number> = {
  small: 88,
  medium: 128,
  large: 184,
};

export function isThumbnailImage(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && THUMBNAIL_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Grid when at least {@link GRID_DEFAULT_IMAGE_SHARE} of the folder's entries are images. */
export function defaultFilesViewMode(
  entries: readonly { name: string; kind: "file" | "directory" }[],
): FilesViewMode {
  if (entries.length === 0) return "list";
  const images = entries.filter((entry) => entry.kind === "file" && isThumbnailImage(entry.name));
  return images.length / entries.length >= GRID_DEFAULT_IMAGE_SHARE ? "grid" : "list";
}

function trimTrailingSeparators(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "/" || /^[A-Za-z]:[\\/]?$/.test(trimmed)) return trimmed;
  return trimmed.replace(/[\\/]+$/, "");
}

/** Comparable form of a folder path: no trailing separator, forward slashes. */
export function normalizeFolderPath(value: string): string {
  return trimTrailingSeparators(value).replace(/\\/g, "/");
}

export function isSameFolder(left: string, right: string): boolean {
  return normalizeFolderPath(left) === normalizeFolderPath(right);
}

export function isPathInsideFolder(candidate: string, folder: string): boolean {
  const child = normalizeFolderPath(candidate);
  const parent = normalizeFolderPath(folder);
  if (!child || !parent) return false;
  if (child === parent) return true;
  return child.startsWith(parent === "/" ? "/" : `${parent}/`);
}

export function folderName(value: string): string {
  const normalized = normalizeFolderPath(value);
  if (normalized === "/" || normalized === "~") return normalized;
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) || normalized : normalized;
}

/** The folder holding a file, for an absolute or home-relative file path. */
export function parentFolder(filePath: string): string | null {
  const normalized = normalizeFolderPath(filePath);
  if (!isAbsolutePath(normalized) && !normalized.startsWith("~/")) return null;
  const index = normalized.lastIndexOf("/");
  if (index < 0) return null;
  if (index === 0) return "/";
  return normalized.slice(0, index);
}

export interface SubagentFolder {
  agentId: string;
  title: string | null;
  cwd: string;
  lastActivityAt: Date;
}

type FolderAgent = Pick<
  Agent,
  "id" | "title" | "cwd" | "workspaceId" | "parentAgentId" | "archivedAt" | "lastActivityAt"
>;

/**
 * Working directories of this workspace's subagents, at any depth, that are not the workspace
 * itself: where delegated agents leave their evidence. One row per directory, most recent
 * activity first.
 */
export function selectSubagentFolders(input: {
  agents: Iterable<FolderAgent>;
  workspaceId: string;
  workspaceRoot: string;
}): SubagentFolder[] {
  const byId = new Map<string, FolderAgent>();
  for (const agent of input.agents) byId.set(agent.id, agent);

  const belongsToWorkspace = (agent: FolderAgent): boolean => {
    const seen = new Set<string>();
    let parentId = agent.parentAgentId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) return false;
      if (parent.workspaceId === input.workspaceId) return true;
      parentId = parent.parentAgentId;
    }
    return false;
  };

  const byFolder = new Map<string, SubagentFolder>();
  for (const agent of byId.values()) {
    if (agent.archivedAt || !agent.parentAgentId || !agent.cwd.trim()) continue;
    if (isSameFolder(agent.cwd, input.workspaceRoot) || !belongsToWorkspace(agent)) continue;
    const key = normalizeFolderPath(agent.cwd);
    const existing = byFolder.get(key);
    if (existing && existing.lastActivityAt >= agent.lastActivityAt) continue;
    byFolder.set(key, {
      agentId: agent.id,
      title: agent.title,
      cwd: agent.cwd,
      lastActivityAt: agent.lastActivityAt,
    });
  }
  return [...byFolder.values()].sort(
    (left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime(),
  );
}
