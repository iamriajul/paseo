import { describe, expect, test } from "vitest";
import { FileHandle } from "../../../file/handle";
import { InMemoryFileSession } from "../../../file/testing";
import { FileEditorModel, type FileEditorClock } from "../model";
import { NativeEditorSession } from "./session";

class TestClock implements FileEditorClock {
  private callback: (() => void) | null = null;

  setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    this.callback = callback;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(): void {
    this.callback = null;
  }

  fire(): void {
    const callback = this.callback;
    this.callback = null;
    callback?.();
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const CONFIGURATION = {
  filename: "notes.md",
  vimEnabled: false,
  theme: {} as never,
};

/** A native editor over a real model and an in-memory disk, the way the WebView host wires it. */
async function openNativeEditor(content: string) {
  const disk = new InMemoryFileSession();
  disk.put("notes.md", content);
  const handle = new FileHandle(disk, { cwd: "/repo", path: "notes.md" }, "/repo/notes.md");
  handle.setObserving(true);
  await settle();
  const clock = new TestClock();
  const model = new FileEditorModel({ file: handle.file, clock });
  model.open();
  await settle();
  const snapshot = model.getSnapshot();
  const session = new NativeEditorSession({
    editorKey: "editor-1",
    content: snapshot.content,
    lineSeparator: snapshot.lineSeparator,
    callbacks: {
      onEdit: (edited) => model.edit(edited),
      onSave: () => void model.save(),
      onCursorChange: () => undefined,
      onVimModeChange: () => undefined,
      onReady: () => undefined,
    },
  });
  /** What the host's effect does after each model change. */
  const follow = () => session.sync(model.getSnapshot().content, model.getSnapshot().lineSeparator);
  return { disk, clock, model, session, follow, read: () => disk.text("notes.md") };
}

describe("native file editor session", () => {
  test("the WebView gets LF text and a keystroke saves with the file's CRLF endings", async () => {
    const editor = await openNativeEditor("one\r\ntwo\r\n");
    const mount = editor.session.mount(CONFIGURATION);

    expect(mount).toMatchObject({ type: "mount", document: { text: "one\ntwo\n", revision: 0 } });
    editor.session.receive({
      type: "change",
      editorKey: "editor-1",
      revision: 0,
      changes: [{ from: 3, to: 3, insert: "!\nnew" }],
    });
    expect(editor.follow()).toBeNull();
    editor.clock.fire();
    await settle();

    expect(editor.read()).toBe("one!\r\nnew\r\ntwo\r\n");
  });

  test("a change typed against text the disk has since replaced is dropped", async () => {
    const editor = await openNativeEditor("first\n");
    editor.session.mount(CONFIGURATION);

    editor.disk.put("notes.md", "second\n");
    await settle();
    expect(editor.follow()).toMatchObject({
      type: "replace",
      document: { text: "second\n", revision: 1 },
    });
    // The keystroke was in flight while the replacement crossed the bridge the other way.
    editor.session.receive({
      type: "change",
      editorKey: "editor-1",
      revision: 0,
      changes: [{ from: 5, to: 5, insert: "!" }],
    });
    editor.clock.fire();
    await settle();

    expect(editor.model.getSnapshot()).toMatchObject({ content: "second\n", modified: false });
    expect(editor.read()).toBe("second\n");
  });

  test("a change against the replacement edits it", async () => {
    const editor = await openNativeEditor("first\n");
    editor.disk.put("notes.md", "second\n");
    await settle();
    editor.follow();

    editor.session.receive({
      type: "change",
      editorKey: "editor-1",
      revision: 1,
      changes: [{ from: 6, to: 6, insert: "!" }],
    });
    editor.clock.fire();
    await settle();

    expect(editor.read()).toBe("second!\n");
  });

  test("a message from another editor, or a change outside the text, edits nothing", async () => {
    const editor = await openNativeEditor("first\n");

    editor.session.receive({
      type: "change",
      editorKey: "editor-0",
      revision: 0,
      changes: [{ from: 0, to: 0, insert: "x" }],
    });
    editor.session.receive({
      type: "change",
      editorKey: "editor-1",
      revision: 0,
      changes: [{ from: 4, to: 99, insert: "x" }],
    });

    expect(editor.model.getSnapshot()).toMatchObject({ content: "first\n", modified: false });
  });

  test("Save from the editor writes at once", async () => {
    const editor = await openNativeEditor("first\n");
    editor.session.receive({
      type: "change",
      editorKey: "editor-1",
      revision: 0,
      changes: [{ from: 0, to: 5, insert: "saved" }],
    });

    editor.session.receive({ type: "save", editorKey: "editor-1" });
    await settle();

    expect(editor.read()).toBe("saved\n");
  });
});
