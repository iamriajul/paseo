export function isPdfMimeType(mimeType: string | null | undefined): boolean {
  return mimeType?.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
}
