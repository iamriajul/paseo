import {
  getMimeTypeFromPath,
  isRasterImageFile,
  isRasterImagePath,
} from "@/attachments/file-types";
import {
  readDesktopFileBytes,
  selectedFileFromWebFile,
  type SelectedFile,
} from "@/attachments/selected-file";
import type { DroppedItem } from "@/components/file-drop/types";

interface DroppedAttachmentsRuntime {
  readDesktopFileBytes(path: string): Promise<Uint8Array>;
}

const defaultRuntime: DroppedAttachmentsRuntime = {
  readDesktopFileBytes,
};

interface DroppedItemsOptions {
  runtime?: DroppedAttachmentsRuntime;
  /**
   * Keep raster images in the result. Consumers that handle raw bytes
   * themselves (e.g. the file explorer uploading into the workspace) set this;
   * the composer leaves images for its image-attachment path.
   */
  includeImages?: boolean;
}

function fileNameFromPath(path: string): string {
  const segments = path.split(/[/\\]/);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment) {
      return segment;
    }
  }
  return path;
}

export function droppedItemsToSelectedFiles(
  items: DroppedItem[],
  options: DroppedItemsOptions = {},
): SelectedFile[] {
  const runtime = options.runtime ?? defaultRuntime;
  const includeImages = options.includeImages ?? false;
  const files: SelectedFile[] = [];

  for (const item of items) {
    if (item.kind === "web-file") {
      if (!includeImages && isRasterImageFile(item.file)) {
        continue;
      }
      files.push(selectedFileFromWebFile(item.file));
      continue;
    }

    if (!includeImages && isRasterImagePath(item.path)) {
      continue;
    }
    const path = item.path;
    files.push({
      fileName: fileNameFromPath(path),
      mimeType: getMimeTypeFromPath(path),
      readBytes: () => runtime.readDesktopFileBytes(path),
    });
  }

  return files;
}
