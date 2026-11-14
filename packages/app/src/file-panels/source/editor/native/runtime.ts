import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { getLanguageForFile } from "@getpaseo/highlight";
import { getCM, vim } from "@replit/codemirror-vim";
import { editorBaseExtensions, editorTheme, type EditorVisualTheme } from "../extensions.web";
import type { NativeEditorConfiguration, NativeEditorDocument, SourceChange } from "./bridge";

export interface NativeEditorRuntimeCallbacks {
  onChange(revision: number, changes: SourceChange[]): void;
  onSave(): void;
  onCursorChange(position: { line: number; column: number }): void;
  onVimModeChange(mode: string | null): void;
}

const remoteUpdate = Annotation.define<boolean>();

/** Markdown is prose, so its paragraphs wrap; code keeps its lines. Matches the web editor. */
const WRAPPED_EXTENSIONS = new Set(["md", "markdown"]);

/** The CodeMirror editor inside the native WebView; the host owns the file and its saving. */
export class NativeEditorRuntime {
  private readonly languageCompartment = new Compartment();
  private readonly wrappingCompartment = new Compartment();
  private readonly themeCompartment = new Compartment();
  private readonly vimCompartment = new Compartment();
  private readonly view: EditorView;
  private readonly callbacks: NativeEditorRuntimeCallbacks;
  private revision: number;
  private vimModeListener: ((event: { mode?: string }) => void) | null = null;

  constructor(input: {
    parent: HTMLElement;
    document: NativeEditorDocument;
    configuration: NativeEditorConfiguration;
    callbacks: NativeEditorRuntimeCallbacks;
  }) {
    const { configuration, callbacks } = input;
    this.callbacks = callbacks;
    this.revision = input.document.revision;
    this.view = new EditorView({
      parent: input.parent,
      state: EditorState.create({
        doc: input.document.text,
        extensions: [
          this.vimCompartment.of(configuration.vimEnabled ? vim() : []),
          ...editorBaseExtensions(() => this.callbacks.onSave()),
          this.languageCompartment.of(languageForFile(configuration.filename)),
          this.wrappingCompartment.of(wrappingForFile(configuration.filename)),
          this.themeCompartment.of(webViewTheme(configuration.theme)),
          EditorView.updateListener.of((update) => this.receiveUpdate(update)),
        ],
      }),
    });
    this.listenToVim(configuration.vimEnabled);
    this.reportCursor();
  }

  replace(document: NativeEditorDocument): void {
    this.revision = document.revision;
    const state = this.view.state;
    if (state.doc.toString() === document.text) return;
    const head = Math.min(state.selection.main.head, document.text.length);
    this.view.dispatch({
      changes: { from: 0, to: state.doc.length, insert: document.text },
      selection: { anchor: head },
      annotations: [remoteUpdate.of(true), Transaction.addToHistory.of(false)],
    });
  }

  configure(configuration: NativeEditorConfiguration): void {
    this.removeVimListener();
    this.view.dispatch({
      effects: [
        this.languageCompartment.reconfigure(languageForFile(configuration.filename)),
        this.wrappingCompartment.reconfigure(wrappingForFile(configuration.filename)),
        this.themeCompartment.reconfigure(webViewTheme(configuration.theme)),
        this.vimCompartment.reconfigure(configuration.vimEnabled ? vim() : []),
      ],
    });
    this.listenToVim(configuration.vimEnabled);
  }

  reveal(target: { lineStart: number; lineEnd?: number }): void {
    const doc = this.view.state.doc;
    const lineStart = Math.min(target.lineStart, doc.lines);
    const lineEnd = Math.min(target.lineEnd ?? lineStart, doc.lines);
    const from = doc.line(lineStart).from;
    const to = doc.line(Math.max(lineStart, lineEnd)).to;
    this.view.dispatch({
      selection: { anchor: from, head: lineEnd > lineStart ? to : from },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
  }

  destroy(): void {
    this.removeVimListener();
    this.view.destroy();
  }

  private receiveUpdate(update: ViewUpdate): void {
    if (
      update.docChanged &&
      !update.transactions.some((transaction) => transaction.annotation(remoteUpdate))
    ) {
      const changes: SourceChange[] = [];
      update.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
        changes.push({ from, to, insert: inserted.toString() });
      });
      this.callbacks.onChange(this.revision, changes);
    }
    if (update.selectionSet || update.docChanged) this.reportCursor();
  }

  private reportCursor(): void {
    const state = this.view.state;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    this.callbacks.onCursorChange({ line: line.number, column: head - line.from + 1 });
  }

  private listenToVim(enabled: boolean): void {
    const cm = enabled ? getCM(this.view) : null;
    if (!cm) {
      this.callbacks.onVimModeChange(null);
      return;
    }
    const listener = (event: { mode?: string }) =>
      this.callbacks.onVimModeChange((event.mode ?? "normal").toUpperCase());
    cm.on("vim-mode-change", listener);
    this.vimModeListener = listener;
    this.callbacks.onVimModeChange("NORMAL");
  }

  private removeVimListener(): void {
    if (!this.vimModeListener) return;
    getCM(this.view)?.off("vim-mode-change", this.vimModeListener);
    this.vimModeListener = null;
  }
}

function languageForFile(filename: string) {
  return getLanguageForFile(filename)?.extension ?? [];
}

function wrappingForFile(filename: string) {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return WRAPPED_EXTENSIONS.has(extension) ? EditorView.lineWrapping : [];
}

/** The app's mono font can be a family the WebView does not have, so it falls back to monospace. */
function webViewTheme(theme: EditorVisualTheme) {
  return editorTheme({ ...theme, monoFont: `${theme.monoFont}, monospace` });
}
