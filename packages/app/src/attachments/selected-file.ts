import { getFileExtension, getMimeTypeFromPath } from "@/attachments/file-types";
import { copyDesktopAttachmentFile } from "@/desktop/attachments/desktop-file-commands";
import { readDesktopFileBase64 } from "@/desktop/attachments/desktop-preview-url";

export interface SelectedFile {
  fileName: string;
  mimeType: string;
  readBytes(): Promise<Uint8Array>;
}

export function selectedFileFromWebFile(file: File): SelectedFile {
  return {
    fileName: file.name,
    mimeType: file.type || getMimeTypeFromPath(file.name),
    readBytes: async () => new Uint8Array(await file.arrayBuffer()),
  };
}

export function selectedFileFromDesktopPath(filePath: string): SelectedFile {
  const segments = filePath.split(/[\\/]/).filter(Boolean);
  const fileName = segments.length > 0 ? segments[segments.length - 1] : filePath;
  return {
    fileName,
    mimeType: getMimeTypeFromPath(filePath),
    readBytes: () => readDesktopFileBytes(filePath),
  };
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export async function readDesktopFileBytes(path: string): Promise<Uint8Array> {
  const { path: managedPath } = await copyDesktopAttachmentFile({
    attachmentId: crypto.randomUUID(),
    sourcePath: path,
    extension: getFileExtension(path) || null,
  });
  const base64 = await readDesktopFileBase64(managedPath);
  return base64ToUint8Array(base64);
}
