export interface PartitionedDrop {
  files: File[];
  skippedDirectoryCount: number;
}

/**
 * Split dropped files from dropped folders. Chromium lists folders in
 * `dataTransfer.files` as 0-byte `File`s, so folder detection needs the items
 * API. When items are unavailable the files pass through untouched.
 */
export function partitionDroppedFiles(
  files: readonly File[],
  items: DataTransferItemList | null | undefined,
): PartitionedDrop {
  if (!items || items.length === 0) {
    return { files: [...files], skippedDirectoryCount: 0 };
  }
  const directoryNames = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind !== "file") {
      continue;
    }
    const entry = item.webkitGetAsEntry();
    if (entry?.isDirectory) {
      directoryNames.add(entry.name);
    }
  }
  if (directoryNames.size === 0) {
    return { files: [...files], skippedDirectoryCount: 0 };
  }
  const kept = files.filter((file) => !directoryNames.has(file.name));
  return { files: kept, skippedDirectoryCount: files.length - kept.length };
}
