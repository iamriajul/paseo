import { describe, expect, it } from "vitest";
import type { ServerBrowserInputEvent } from "@getpaseo/protocol/server-browser/rpc-schemas";
import { InputBatcher, keyboardEventToInput } from "./input";
import {
  quantizeScreencastViewport,
  streamingViewport,
  surfacePointToPage,
} from "./use-screencast";

function createBatcher() {
  const batches: ServerBrowserInputEvent[][] = [];
  return { batches, batcher: new InputBatcher(async (events) => batches.push(events)) };
}

const move = (x: number): ServerBrowserInputEvent => ({
  kind: "mouse",
  action: "move",
  x,
  y: 0.5,
  button: "none",
  clickCount: 0,
});

describe("InputBatcher", () => {
  it("keeps only the latest pointer move and sends a press at once, after it", () => {
    const { batches, batcher } = createBatcher();
    batcher.push(move(0.1), false);
    batcher.push(move(0.2), false);
    batcher.push(
      { kind: "mouse", action: "down", x: 0.2, y: 0.5, button: "left", clickCount: 1 },
      true,
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((event) => event.kind === "mouse" && [event.action, event.x])).toEqual([
      ["move", 0.2],
      ["down", 0.2],
    ]);
  });

  it("sums consecutive wheel ticks", () => {
    const { batches, batcher } = createBatcher();
    batcher.push({ kind: "wheel", x: 0.5, y: 0.5, deltaX: 0, deltaY: 40 }, false);
    batcher.push({ kind: "wheel", x: 0.5, y: 0.5, deltaX: 0, deltaY: 60 }, false);
    batcher.flush();
    expect(batches).toEqual([[{ kind: "wheel", x: 0.5, y: 0.5, deltaX: 0, deltaY: 100 }]]);
  });
});

describe("keyboardEventToInput", () => {
  const plain = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

  it("gives a printable key its text so the page sees an input", () => {
    expect(keyboardEventToInput({ key: "a", code: "KeyA", keyCode: 65, ...plain }, "down")).toEqual(
      [{ kind: "key", action: "down", key: "a", code: "KeyA", keyCode: 65, text: "a" }],
    );
  });

  it("sends Enter with a carriage return so forms submit", () => {
    const [event] = keyboardEventToInput(
      { key: "Enter", code: "Enter", keyCode: 13, ...plain },
      "down",
    );
    expect(event).toMatchObject({ text: "\r" });
  });

  it("sends Control+A as a shortcut, not as text", () => {
    const [event] = keyboardEventToInput(
      { key: "a", code: "KeyA", keyCode: 65, ...plain, ctrlKey: true },
      "down",
    );
    expect(event).toEqual({
      kind: "key",
      action: "down",
      key: "a",
      code: "KeyA",
      keyCode: 65,
      modifiers: ["Control"],
    });
  });
});

describe("surfacePointToPage", () => {
  it("maps through the letterbox of a wide page in a tall surface", () => {
    // 1280x800 page in a 400x800 surface: shown 400x250, centred vertically at y 275..525.
    const page = { surfaceWidth: 400, surfaceHeight: 800, pageWidth: 1280, pageHeight: 800 };
    expect(surfacePointToPage({ ...page, x: 200, y: 400 })).toEqual({ x: 0.5, y: 0.5 });
    expect(surfacePointToPage({ ...page, x: 200, y: 100 })).toBeNull();
  });
});

describe("quantizeScreencastViewport", () => {
  it("keeps the stream for a small resize and restarts it for a large one", () => {
    const first = quantizeScreencastViewport(null, { maxWidth: 1203, maxHeight: 788 });
    expect(first).toEqual({ maxWidth: 1200, maxHeight: 800 });
    expect(quantizeScreencastViewport(first, { maxWidth: 1250, maxHeight: 790 })).toBe(first);
    expect(quantizeScreencastViewport(first, { maxWidth: 600, maxHeight: 790 })).toEqual({
      maxWidth: 600,
      maxHeight: 800,
    });
  });
});

// Fork: server-browser-suspend-idle-tabs in docs/fork-decisions.md.
describe("streamingViewport", () => {
  it("streams only a tab on screen", () => {
    const hiddenSize = quantizeScreencastViewport(null, { maxWidth: 0, maxHeight: 0 });
    expect(streamingViewport(hiddenSize, false)).toBeNull();
    expect(streamingViewport({ maxWidth: 1200, maxHeight: 800 }, false)).toBeNull();
    expect(streamingViewport(null, true)).toBeNull();
    expect(streamingViewport({ maxWidth: 1200, maxHeight: 800 }, true)).toEqual({
      maxWidth: 1200,
      maxHeight: 800,
    });
  });
});
