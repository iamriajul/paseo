import type { ExplorerDirectory, ExplorerEntry } from "@/stores/session-store";
import { parentExplorerPath } from "@/utils/explorer-paths";

/**
 * Where pane-level uploads land: the selected folder, the selected file's
 * parent folder, or the workspace root when nothing is selected.
 */
export function resolveUploadParentPath(selectedEntry: ExplorerEntry | null): string {
  if (!selectedEntry) {
    return ".";
  }
  return selectedEntry.kind === "directory"
    ? selectedEntry.path
    : parentExplorerPath(selectedEntry.path);
}

export function findExplorerEntryByPath(
  directories: ReadonlyMap<string, ExplorerDirectory>,
  entryPath: string,
): ExplorerEntry | null {
  for (const directory of directories.values()) {
    const match = directory.entries.find((entry) => entry.path === entryPath);
    if (match) {
      return match;
    }
  }
  return null;
}

/**
 * Trimmed names in `fileNames` that already exist as files in the target
 * folder. Fails closed: an unlisted folder conflicts with everything, and the
 * comparison is case-insensitive so case variants confirm on macOS/Windows
 * (harmless extra confirm on Linux, where they are distinct files).
 */
export function findUploadConflicts(args: {
  parentPath: string;
  fileNames: readonly string[];
  directories: ReadonlyMap<string, ExplorerDirectory>;
}): string[] {
  const trimmed = args.fileNames.map((fileName) => fileName.trim()).filter((name) => name !== "");
  const directory = args.directories.get(args.parentPath);
  if (!directory) {
    return [...new Set(trimmed)];
  }
  const existingNames = new Set(
    directory.entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.name.toLowerCase()),
  );
  return [...new Set(trimmed.filter((name) => existingNames.has(name.toLowerCase())))];
}

/**
 * Trimmed names occurring more than once in one batch (case-insensitive):
 * later copies replace earlier ones, so they need the same confirm.
 */
export function findBatchDuplicateNames(fileNames: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const fileName of fileNames) {
    const key = fileName.trim().toLowerCase();
    if (key === "") {
      continue;
    }
    if (seen.has(key)) {
      duplicates.add(fileName.trim());
    } else {
      seen.add(key);
    }
  }
  return [...duplicates];
}

const MAX_CONFLICT_NAMES_SHOWN = 5;

/** 'a.txt', 'b.txt', … — capped so a big drop does not flood the dialog. */
export function formatUploadConflictNames(conflicts: readonly string[]): string {
  const shown = conflicts.slice(0, MAX_CONFLICT_NAMES_SHOWN).map((name) => `"${name}"`);
  if (conflicts.length > MAX_CONFLICT_NAMES_SHOWN) {
    shown.push("…");
  }
  return shown.join(", ");
}
