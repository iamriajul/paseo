import { parseNativeEditorCommand, type NativeEditorEvent } from "./bridge";
import { NativeEditorRuntime } from "./runtime";

declare global {
  interface Window {
    __PASEO_SOURCE_EDITOR_RECEIVE__?: (data: string) => void;
  }
}

function send(event: NativeEditorEvent): void {
  window.ReactNativeWebView?.postMessage?.(JSON.stringify(event));
}

const host = document.createElement("div");
host.id = "source-editor-host";
document.body.appendChild(host);

let editorKey: string | null = null;
let runtime: NativeEditorRuntime | null = null;

window.__PASEO_SOURCE_EDITOR_RECEIVE__ = (data) => {
  const command = parseNativeEditorCommand(data);
  if (!command) return;
  if (command.type === "mount") {
    runtime?.destroy();
    const key = command.editorKey;
    editorKey = key;
    runtime = new NativeEditorRuntime({
      parent: host,
      document: command.document,
      configuration: command.configuration,
      callbacks: {
        onChange: (revision, changes) =>
          send({ type: "change", editorKey: key, revision, changes }),
        onSave: () => send({ type: "save", editorKey: key }),
        onCursorChange: (position) => send({ type: "cursor", editorKey: key, ...position }),
        onVimModeChange: (mode) => send({ type: "vimMode", editorKey: key, mode }),
      },
    });
    send({ type: "ready", editorKey: key });
    return;
  }
  if (!runtime || command.editorKey !== editorKey) return;
  switch (command.type) {
    case "replace":
      runtime.replace(command.document);
      return;
    case "configure":
      runtime.configure(command.configuration);
      return;
    case "reveal":
      runtime.reveal(command);
      return;
  }
};

send({ type: "bridgeReady" });
