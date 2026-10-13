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

export interface UploadSingleFileResult {
  success: boolean;
  path: string | null;
  error: string | null;
  alreadyExists?: boolean;
}

export interface UploadSingleFileOutcome {
  uploadedPath: string | null;
  error: string | null;
  cancelled?: boolean;
}

/**
 * Upload one file, retrying once with overwrite after a confirm when the
 * server reports the entry appeared between the conflict check and the send.
 */
export async function uploadSingleFile(args: {
  trimmedName: string;
  needsOverwrite: boolean;
  send: (overwrite: boolean) => Promise<UploadSingleFileResult | null>;
  confirm: (names: readonly string[]) => Promise<boolean>;
}): Promise<UploadSingleFileOutcome> {
  try {
    const payload = await args.send(args.needsOverwrite);
    if (payload?.success && payload.path) {
      return { uploadedPath: payload.path, error: null };
    }
    if (payload?.alreadyExists && !args.needsOverwrite) {
      const retryConfirmed = await args.confirm([args.trimmedName]);
      if (!retryConfirmed) {
        return { uploadedPath: null, error: null, cancelled: true };
      }
      const retry = await args.send(true);
      if (retry?.success && retry.path) {
        return { uploadedPath: retry.path, error: null };
      }
      return { uploadedPath: null, error: retry?.error ?? null };
    }
    return { uploadedPath: null, error: payload?.error ?? null };
  } catch (cause) {
    return {
      uploadedPath: null,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
