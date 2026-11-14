import type { FileLineSeparator } from "../model";
import type {
  NativeEditorCommand,
  NativeEditorConfiguration,
  NativeEditorEvent,
  SourceChange,
} from "./bridge";

export interface NativeEditorSessionCallbacks {
  /** The edited text, in the file's own line separator. */
  onEdit(content: string): void;
  onSave(): void;
  onCursorChange(position: { line: number; column: number }): void;
  onVimModeChange(mode: string | null): void;
  onReady(): void;
}

/**
 * The host's side of one native editor: a mirror of the WebView's LF-only text, so a keystroke
 * crosses the bridge as a small change instead of the whole file. Edits come back in the file's
 * own line separator, the way the web editor writes them.
 */
export class NativeEditorSession {
  readonly editorKey: string;
  private text: string;
  private revision = 0;
  private lineSeparator: FileLineSeparator;
  private readonly callbacks: NativeEditorSessionCallbacks;

  constructor(input: {
    editorKey: string;
    content: string;
    lineSeparator: FileLineSeparator;
    callbacks: NativeEditorSessionCallbacks;
  }) {
    this.editorKey = input.editorKey;
    this.text = toEditorText(input.content);
    this.lineSeparator = input.lineSeparator;
    this.callbacks = input.callbacks;
  }

  mount(configuration: NativeEditorConfiguration): NativeEditorCommand {
    return {
      type: "mount",
      editorKey: this.editorKey,
      document: { text: this.text, revision: this.revision },
      configuration,
    };
  }

  /**
   * Follows the buffer after the model changed it without the editor (a reload from disk). Answers
   * the replacement to send, or null when the editor already shows this text.
   */
  sync(content: string, lineSeparator: FileLineSeparator): NativeEditorCommand | null {
    this.lineSeparator = lineSeparator;
    const text = toEditorText(content);
    if (text === this.text) return null;
    this.text = text;
    this.revision += 1;
    return {
      type: "replace",
      editorKey: this.editorKey,
      document: { text, revision: this.revision },
    };
  }

  receive(event: NativeEditorEvent): void {
    if (event.type === "bridgeReady" || event.editorKey !== this.editorKey) return;
    switch (event.type) {
      case "ready":
        this.callbacks.onReady();
        return;
      case "change": {
        // Typed against text a replacement has since overwritten in the WebView too.
        if (event.revision !== this.revision) return;
        const text = applyChanges(this.text, event.changes);
        if (text === null) return;
        this.text = text;
        this.callbacks.onEdit(fromEditorText(text, this.lineSeparator));
        return;
      }
      case "cursor":
        this.callbacks.onCursorChange({ line: event.line, column: event.column });
        return;
      case "save":
        this.callbacks.onSave();
        return;
      case "vimMode":
        this.callbacks.onVimModeChange(event.mode);
        return;
    }
  }
}

/** Applies ascending, non-overlapping changes; null when one does not fit the text. */
function applyChanges(text: string, changes: readonly SourceChange[]): string | null {
  let previousEnd = 0;
  for (const change of changes) {
    if (change.from < previousEnd || change.from > change.to || change.to > text.length) {
      return null;
    }
    previousEnd = change.to;
  }
  let next = text;
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const change = changes[index];
    next = next.slice(0, change.from) + toEditorText(change.insert) + next.slice(change.to);
  }
  return next;
}

function toEditorText(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

function fromEditorText(text: string, lineSeparator: FileLineSeparator): string {
  return lineSeparator === "\n" ? text : text.replace(/\n/g, lineSeparator);
}
