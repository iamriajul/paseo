export function isPdfMimeType(mimeType: string | null | undefined): boolean {
  return mimeType?.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
}

export function shouldPersistFilePreviewMedia(file: { kind: string; mime: string }): boolean {
  return file.kind === "image" || isPdfMimeType(file.mime);
}
