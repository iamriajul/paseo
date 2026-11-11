import type { ExplorerDirectory } from "@/stores/session-store";
import type { SortOption } from "@/stores/panel-store/state";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { sortedExplorerDirectoryEntries } from "../tree";
import {
  isPathInsideFolder,
  isSameFolder,
  isThumbnailImage,
  normalizeFolderPath,
} from "../folders/model";

export interface ImageGalleryItem {
  /** The file tab target path: workspace-relative inside the workspace, absolute outside it. */
  targetPath: string;
  name: string;
}

export interface ImageGallery {
  items: readonly ImageGalleryItem[];
  index: number;
}

/**
 * The images in the open image's folder, in the order Files shows them, when Files has listed
 * that folder under its current root. Null when there is nothing to page to.
 */
export function resolveImageGallery(input: {
  /** The file tab's target path. */
  filePath: string;
  workspaceRoot: string;
  /** The root Files shows: the workspace or a folder outside it. */
  filesRoot: string;
  directories: ReadonlyMap<string, ExplorerDirectory> | undefined;
  sortOption: SortOption;
  showHiddenFiles: boolean;
}): ImageGallery | null {
  const { directories, filesRoot, workspaceRoot } = input;
  if (!directories) return null;
  const absolute = buildAbsoluteExplorerPath({ workspaceRoot, entryPath: input.filePath });
  if (!isThumbnailImage(absolute) || !isPathInsideFolder(absolute, filesRoot)) return null;
  const root = normalizeFolderPath(filesRoot);
  const relative = normalizeFolderPath(absolute).slice(root === "/" ? 1 : root.length + 1);
  const slash = relative.lastIndexOf("/");
  const directory = directories.get(slash < 0 ? "." : relative.slice(0, slash));
  if (!directory) return null;
  const images = sortedExplorerDirectoryEntries(
    directory,
    input.sortOption,
    input.showHiddenFiles,
  ).filter((entry) => entry.kind === "file" && isThumbnailImage(entry.name));
  if (images.length < 2) return null;
  const index = images.findIndex((entry) => normalizeFolderPath(entry.path) === relative);
  if (index < 0) return null;
  const outside = !isSameFolder(filesRoot, workspaceRoot);
  return {
    index,
    items: images.map((entry) => ({
      name: entry.name,
      targetPath: outside
        ? buildAbsoluteExplorerPath({ workspaceRoot: filesRoot, entryPath: entry.path })
        : entry.path,
    })),
  };
}

/** The index one step away, or null past either end. The gallery does not wrap. */
export function stepImageGallery(gallery: ImageGallery, delta: -1 | 1): number | null {
  const next = gallery.index + delta;
  return next >= 0 && next < gallery.items.length ? next : null;
}
