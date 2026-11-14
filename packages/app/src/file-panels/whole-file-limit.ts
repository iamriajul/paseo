/**
 * Built-in panels that read the whole file into the app's memory before they show anything. A
 * larger file offers Download instead: reading it would hold the tab on a spinner for the whole
 * transfer and could exhaust a phone's memory. Text panels have their own budgets
 * (`source/readonly/presentation.ts`); Media streams.
 */
const WHOLE_FILE_PANELS: ReadonlySet<string> = new Set([
  "builtin:image",
  "builtin:pdf",
  "builtin:office",
]);

/** The web cap matches the media panel's in-memory playback and the legacy download cap. */
export const WHOLE_FILE_PREVIEW_MAX_BYTES = {
  web: 64 * 1024 * 1024,
  native: 32 * 1024 * 1024,
} as const;

export function exceedsWholeFilePreview(input: {
  panelId: string;
  size: number;
  platform: keyof typeof WHOLE_FILE_PREVIEW_MAX_BYTES;
}): boolean {
  return (
    WHOLE_FILE_PANELS.has(input.panelId) &&
    input.size > WHOLE_FILE_PREVIEW_MAX_BYTES[input.platform]
  );
}
