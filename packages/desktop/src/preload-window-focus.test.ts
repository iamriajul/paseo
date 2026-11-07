import { describe, expect, it, vi } from "vitest";

type Listener = (event: unknown, payload: unknown) => void;

const listeners = new Map<string, Listener[]>();
let exposed: Record<string, unknown> | null = null;

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>) => {
      exposed = api;
    },
  },
  ipcRenderer: {
    on: (channel: string, listener: Listener) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
    },
    removeListener: () => {},
    invoke: (channel: string) =>
      Promise.resolve(channel === "paseo:window:isFocused" ? true : null),
    send: () => {},
    sendSync: () => null,
  },
  webUtils: { getPathForFile: () => "" },
}));

function emitFocusState(focused: boolean): void {
  for (const listener of listeners.get("paseo:window:focus-state") ?? []) {
    listener({}, { focused });
  }
}

interface WindowBridge {
  isFocused: () => boolean;
}

function currentWindow(): WindowBridge {
  const desktopWindow = exposed?.window as { getCurrentWindow: () => WindowBridge };
  return desktopWindow.getCurrentWindow();
}

describe("preload window focus", () => {
  it("reports a blurred window as unfocused on a freshly obtained window bridge", async () => {
    await import("./preload");
    await Promise.resolve();

    emitFocusState(false);
    // The renderer calls getCurrentWindow() on every visibility check.
    expect(currentWindow().isFocused()).toBe(false);

    emitFocusState(true);
    expect(currentWindow().isFocused()).toBe(true);
  });

  it("does not add a focus listener per getCurrentWindow call", async () => {
    await import("./preload");
    const before = listeners.get("paseo:window:focus-state")?.length ?? 0;
    currentWindow();
    currentWindow();
    expect(listeners.get("paseo:window:focus-state")?.length ?? 0).toBe(before);
  });
});
