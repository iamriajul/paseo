import type { EditorVisualTheme } from "../extensions.web";

/** A replaced range of the editor's text, in its LF-only coordinates. */
export interface SourceChange {
  from: number;
  to: number;
  insert: string;
}

export interface NativeEditorConfiguration {
  filename: string;
  vimEnabled: boolean;
  theme: EditorVisualTheme;
}

/**
 * The text the WebView shows. `revision` names it: each change the editor sends carries the
 * revision it was typed against, so the host drops a change that crossed a replacement in flight.
 */
export interface NativeEditorDocument {
  text: string;
  revision: number;
}

/** Host to WebView. */
export type NativeEditorCommand =
  | {
      type: "mount";
      editorKey: string;
      document: NativeEditorDocument;
      configuration: NativeEditorConfiguration;
    }
  | { type: "replace"; editorKey: string; document: NativeEditorDocument }
  | { type: "configure"; editorKey: string; configuration: NativeEditorConfiguration }
  | { type: "reveal"; editorKey: string; lineStart: number; lineEnd?: number };

/** WebView to host. */
export type NativeEditorEvent =
  | { type: "bridgeReady" }
  | { type: "ready"; editorKey: string }
  | { type: "change"; editorKey: string; revision: number; changes: SourceChange[] }
  | { type: "cursor"; editorKey: string; line: number; column: number }
  | { type: "save"; editorKey: string }
  | { type: "vimMode"; editorKey: string; mode: string | null };

/** Parses what the WebView posted; anything malformed is dropped. */
export function parseNativeEditorEvent(data: string): NativeEditorEvent | null {
  const value = parseJsonRecord(data);
  if (!value || typeof value.type !== "string") return null;
  if (value.type === "bridgeReady") return { type: "bridgeReady" };
  const editorKey = value.editorKey;
  if (typeof editorKey !== "string") return null;
  switch (value.type) {
    case "ready":
    case "save":
      return { type: value.type, editorKey };
    case "vimMode":
      return value.mode === null || typeof value.mode === "string"
        ? { type: "vimMode", editorKey, mode: value.mode }
        : null;
    case "cursor":
      return isPositiveInteger(value.line) && isPositiveInteger(value.column)
        ? { type: "cursor", editorKey, line: value.line, column: value.column }
        : null;
    case "change": {
      const changes = parseChanges(value.changes);
      return changes && isNonNegativeInteger(value.revision)
        ? { type: "change", editorKey, revision: value.revision, changes }
        : null;
    }
    default:
      return null;
  }
}

/**
 * Parses what the host injected. Both sides ship in one app build, so the WebView only checks the
 * shape it dispatches on.
 */
export function parseNativeEditorCommand(data: string): NativeEditorCommand | null {
  const value = parseJsonRecord(data);
  if (!value || typeof value.editorKey !== "string") return null;
  switch (value.type) {
    case "mount":
    case "replace":
    case "configure":
    case "reveal":
      return value as unknown as NativeEditorCommand;
    default:
      return null;
  }
}

function parseChanges(value: unknown): SourceChange[] | null {
  if (!Array.isArray(value)) return null;
  const changes: SourceChange[] = [];
  for (const change of value) {
    if (
      !isRecord(change) ||
      !isNonNegativeInteger(change.from) ||
      !isNonNegativeInteger(change.to) ||
      typeof change.insert !== "string"
    ) {
      return null;
    }
    changes.push({ from: change.from, to: change.to, insert: change.insert });
  }
  return changes;
}

function parseJsonRecord(data: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}
