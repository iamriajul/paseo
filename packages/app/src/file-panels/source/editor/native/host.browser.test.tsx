import {
  act,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { FileHandle } from "../../../file/handle";
import { InMemoryFileSession } from "../../../file/testing";
import { FileEditorModel } from "../model";
import { FileEditorView } from "./host";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface WebViewDoubleProps {
  source: { html: string };
  testID?: string;
  onMessage?: (event: { nativeEvent: { data: string } }) => void;
}

// A WebView is a browser engine with a message channel. This one loads the bundled page into an
// iframe, wires `window.ReactNativeWebView.postMessage` to `onMessage`, and runs injected scripts
// as inline scripts, which the page's policy allows.
vi.mock("react-native-webview", () => ({
  WebView: forwardRef(function WebViewDouble(props: WebViewDoubleProps, ref) {
    const frame = useRef<HTMLIFrameElement>(null);
    const onMessage = useRef(props.onMessage);
    onMessage.current = props.onMessage;
    const [channel] = useState(() => `__webViewDouble${Math.random().toString(36).slice(2)}`);
    useImperativeHandle(ref, () => ({
      injectJavaScript(code: string) {
        const document = frame.current?.contentDocument;
        if (!document?.body) return;
        const script = document.createElement("script");
        script.textContent = code;
        document.body.appendChild(script);
        script.remove();
      },
      reload() {},
    }));
    useEffect(() => {
      Object.assign(window, {
        [channel]: (data: string) => onMessage.current?.({ nativeEvent: { data } }),
      });
      return () => {
        Reflect.deleteProperty(window, channel);
      };
    }, [channel]);
    const html = props.source.html.replace(
      "<head>",
      `<head><script>window.ReactNativeWebView={postMessage:function(d){parent["${channel}"](d)}}</script>`,
    );
    return (
      // oxlint-disable-next-line react/iframe-missing-sandbox -- stands in for a native WebView, which has no sandbox; the test reads the page's DOM
      <iframe ref={frame} srcDoc={html} data-testid={props.testID} style={FRAME_STYLE} />
    );
  }),
}));

const FRAME_STYLE = { width: 390, height: 480, border: 0 };

const THEME = {
  colorScheme: "dark" as const,
  background: "#111111",
  foreground: "#eeeeee",
  cursor: "#ffffff",
  foregroundMuted: "#888888",
  border: "#333333",
  selection: "#444444",
  monoFont: "monospace",
  codeFontSize: 12,
  syntax: {} as never,
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("timed out");
    await act(() => new Promise((resolve) => setTimeout(resolve, 25)));
  }
}

type EditorProps = ComponentProps<typeof FileEditorView>;

/**
 * Re-renders the editor on every cursor and vim-mode report with a new theme object, as the file
 * panel's toolbar state and the themed wrapper do.
 */
function PanelHarness(props: Omit<EditorProps, "theme">) {
  const [, setCursor] = useState(props.location);
  const [, setVimMode] = useState<string | null>(null);
  const editorProps: EditorProps = {
    ...props,
    theme: { ...THEME },
    onCursorChange: (position) => {
      props.onCursorChange(position);
      setCursor({ path: props.location.path, lineStart: position.line });
    },
    onVimModeChange: (mode) => {
      props.onVimModeChange(mode);
      setVimMode(mode);
    },
  };
  return <FileEditorView {...editorProps} />;
}

/** The native editor over a real model and an in-memory disk, rendered as the file panel does. */
async function renderNativeEditor(
  content: string,
  options: { lineStart?: number; vimEnabled?: boolean } = {},
) {
  const disk = new InMemoryFileSession();
  disk.put("notes.ts", content);
  const handle = new FileHandle(disk, { cwd: "/repo", path: "notes.ts" }, "/repo/notes.ts");
  handle.setObserving(true);
  await settle();
  const model = new FileEditorModel({ file: handle.file });
  model.open();
  await waitFor(() => model.getSnapshot().status === "clean");
  const state = { ready: false, cursor: { line: 0, column: 0 }, vimMode: null as string | null };
  const props: Omit<EditorProps, "theme"> = {
    model,
    filename: "notes.ts",
    location: { path: "notes.ts", lineStart: options.lineStart },
    navigationRevision: options.lineStart ? 1 : 0,
    vimEnabled: options.vimEnabled ?? false,
    onCursorChange: (position) => {
      state.cursor = position;
    },
    onVimModeChange: (mode) => {
      state.vimMode = mode;
    },
    onReady: () => {
      state.ready = true;
    },
  };
  act(() => root.render(<PanelHarness {...props} />));
  await waitFor(() => state.ready);
  const frame = container.querySelector<HTMLIFrameElement>("[data-testid='file-source-editor']");
  const editorContent = () => frame?.contentDocument?.querySelector<HTMLElement>(".cm-content");
  return { disk, model, state, editorContent, read: () => disk.text("notes.ts") };
}

it("a keystroke in the bundled editor saves the file with its CRLF endings", async () => {
  const editor = await renderNativeEditor("alpha\r\nbeta\r\n", { lineStart: 1 });

  editor.editorContent()?.focus();
  await userEvent.keyboard("X");

  expect(editor.model.getSnapshot()).toMatchObject({ content: "Xalpha\r\nbeta\r\n" });
  await waitFor(() => editor.read() === "Xalpha\r\nbeta\r\n", 3_000);
});

it("a file changed on disk shows in the editor", async () => {
  const editor = await renderNativeEditor("first\n");

  editor.disk.put("notes.ts", "second\n");

  await waitFor(() => editor.editorContent()?.textContent === "second");
  expect(editor.model.getSnapshot()).toMatchObject({ content: "second\n", modified: false });
});

it("a line target selects that line", async () => {
  const lines = Array.from({ length: 200 }, (_, index) => `const line${index + 1} = ${index};`);
  const editor = await renderNativeEditor(lines.join("\n"), { lineStart: 150 });

  await waitFor(() => editor.state.cursor.line === 150);
});

it("vim keeps insert mode while the panel re-renders around the editor", async () => {
  const editor = await renderNativeEditor("abc\n", { lineStart: 1, vimEnabled: true });
  await waitFor(() => editor.state.vimMode === "NORMAL");

  editor.editorContent()?.focus();
  await userEvent.keyboard("iXY");

  await waitFor(() => editor.model.getSnapshot().content === "XYabc\n");
  expect(editor.state.vimMode).toBe("INSERT");
});
