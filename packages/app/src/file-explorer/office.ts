// One registry for the Office files the pane can render. PDF stays on its own
// renderer. Extension is the fallback because a daemon that predates this table
// advertises application/octet-stream for every zip-based document.

export const OFFICE_PREVIEW_FORMATS = [
  {
    kind: "docx",
    extensions: [".docx", ".docm", ".dotx", ".dotm"],
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-word.document.macroenabled.12",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
      "application/vnd.ms-word.template.macroenabled.12",
    ],
  },
  {
    kind: "xlsx",
    extensions: [".xlsx", ".xlsm", ".xltx", ".xltm"],
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel.sheet.macroenabled.12",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
      "application/vnd.ms-excel.template.macroenabled.12",
    ],
  },
  {
    kind: "pptx",
    extensions: [".pptx", ".pptm", ".potx", ".potm"],
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-powerpoint.presentation.macroenabled.12",
      "application/vnd.openxmlformats-officedocument.presentationml.template",
      "application/vnd.ms-powerpoint.template.macroenabled.12",
    ],
  },
] as const;

export type OfficePreviewKind = (typeof OFFICE_PREVIEW_FORMATS)[number]["kind"];

function bareMime(mimeType: string | null | undefined): string {
  return mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function extensionOf(path: string): string {
  const clean = path.split("#", 1)[0]?.split("?", 1)[0] ?? path;
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  const base = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return base.slice(dot).toLowerCase();
}

export function officePreviewKind(input: {
  mimeType?: string | null;
  path?: string | null;
}): OfficePreviewKind | null {
  const mime = bareMime(input.mimeType);
  if (mime) {
    for (const format of OFFICE_PREVIEW_FORMATS) {
      if ((format.mimeTypes as readonly string[]).includes(mime)) return format.kind;
    }
  }
  const extension = input.path ? extensionOf(input.path) : "";
  if (!extension) return null;
  for (const format of OFFICE_PREVIEW_FORMATS) {
    if ((format.extensions as readonly string[]).includes(extension)) return format.kind;
  }
  return null;
}
