import { describe, expect, it, vi } from "vitest";
import { type BridgeEvent, createPreviewBridge } from "./web-bridge";

const ORIGIN = "https://3000.preview.example.com";

function harness({ frameIsMounted = true }: { frameIsMounted?: boolean } = {}) {
  // Keyed by event name, so every test in this file runs through the name the
  // bridge actually registered. A typo there reaches nobody on deliver(), and a
  // removeEventListener with a mismatched name leaves the listener attached —
  // both of which a name-blind fake would swallow.
  const handlers = new Map<string, Set<(event: MessageEvent) => void>>();
  const listenedTypes: string[] = [];
  const frame = { postMessage: vi.fn() } as unknown as Window;
  const listenTarget = {
    addEventListener: (type: string, handler: (event: MessageEvent) => void) => {
      listenedTypes.push(type);
      const forType = handlers.get(type) ?? new Set<(event: MessageEvent) => void>();
      forType.add(handler);
      handlers.set(type, forType);
    },
    removeEventListener: (type: string, handler: (event: MessageEvent) => void) => {
      handlers.get(type)?.delete(handler);
    },
  } as unknown as Window;
  const events: BridgeEvent[] = [];
  const bridge = createPreviewBridge({
    origin: ORIGIN,
    getFrame: () => (frameIsMounted ? frame : null),
    onEvent: (event) => events.push(event),
    listenTarget,
  });
  const deliver = (data: unknown, overrides: Partial<MessageEvent> = {}) => {
    for (const handler of handlers.get("message") ?? []) {
      handler({ data, origin: ORIGIN, source: frame, ...overrides } as MessageEvent);
    }
  };
  return { bridge, events, frame, deliver, listenedTypes };
}

const navigation = {
  source: "paseo-browser-bridge",
  type: "navigation",
  payload: {
    docId: "d1",
    seq: 1,
    url: "http://localhost:3000/a",
    title: "A",
    canGoBack: false,
    canGoForward: false,
  },
};

describe("createPreviewBridge", () => {
  it("subscribes to message events under that exact name", () => {
    // Untested, a typo here is silent: nothing else in this file reads the
    // event name, so the bridge would be inert in production with a green suite.
    const { listenedTypes } = harness();
    expect(listenedTypes).toEqual(["message"]);
  });

  it("accepts a navigation message from the preview origin", () => {
    const { events, deliver } = harness();
    deliver(navigation);
    expect(events).toEqual([
      {
        type: "navigation",
        docId: "d1",
        seq: 1,
        url: "http://localhost:3000/a",
        title: "A",
        canGoBack: false,
        canGoForward: false,
      },
    ]);
  });

  it("rejects a message from a different origin", () => {
    const { events, deliver } = harness();
    deliver(navigation, { origin: "https://evil.example.com" });
    expect(events).toEqual([]);
  });

  it("rejects a message from a window that is not the frame", () => {
    const { events, deliver } = harness();
    deliver(navigation, { source: {} as Window });
    expect(events).toEqual([]);
  });

  it("rejects a foreign source field", () => {
    const { events, deliver } = harness();
    deliver({ ...navigation, source: "somebody-else" });
    expect(events).toEqual([]);
  });

  it("rejects a malformed payload rather than passing it on", () => {
    const { events, deliver } = harness();
    deliver({ ...navigation, payload: { seq: "one" } });
    expect(events).toEqual([]);
  });

  it("targets the preview origin exactly when sending", () => {
    const { bridge, frame } = harness();
    bridge.send({ command: "back" });
    expect(frame.postMessage).toHaveBeenCalledWith(
      { source: "paseo-browser", command: "back" },
      ORIGIN,
    );
  });

  it("sends goto with its url", () => {
    const { bridge, frame } = harness();
    bridge.send({ command: "goto", url: "http://localhost:3000/x" });
    expect(frame.postMessage).toHaveBeenCalledWith(
      { source: "paseo-browser", command: "goto", url: "http://localhost:3000/x" },
      ORIGIN,
    );
  });

  it("stops listening after dispose", () => {
    const { bridge, events, deliver } = harness();
    bridge.dispose();
    deliver(navigation);
    expect(events).toEqual([]);
  });

  it("rejects a message when the frame is gone", () => {
    // A worker or service-worker message has source null. With the iframe
    // unmounted, getFrame() is null too, so an identity check alone matches.
    const { events, deliver } = harness({ frameIsMounted: false });
    deliver(navigation, { source: null });
    expect(events).toEqual([]);
  });

  it("forwards a ready message with its docId", () => {
    const { events, deliver } = harness();
    deliver({ source: "paseo-browser-bridge", type: "ready", payload: { docId: "d9" } });
    expect(events).toEqual([{ type: "ready", docId: "d9" }]);
  });

  it("forwards a selection payload field for field", () => {
    const { events, deliver } = harness();
    const payload = {
      url: "http://localhost:3000/a",
      selector: "#root > div.card",
      tag: "div",
      text: "Hello",
      outerHTML: '<div class="card">Hello</div>',
      computedStyles: { display: "block", color: "rgb(0, 0, 0)" },
      boundingRect: { x: 1, y: 2, width: 3, height: 4 },
      reactSource: {
        fileName: "src/card.tsx",
        lineNumber: 12,
        columnNumber: 3,
        componentName: "Card",
      },
      parentChain: ["div#root", "body"],
      children: ["span"],
    };
    deliver({ source: "paseo-browser-bridge", type: "selection", payload });
    expect(events).toEqual([{ type: "selection", selection: payload }]);
  });

  it("forwards the payload-less events", () => {
    const { events, deliver } = harness();
    for (const type of ["select-cancelled", "eruda-ready", "eruda-failed"]) {
      deliver({ source: "paseo-browser-bridge", type, payload: {} });
    }
    expect(events).toEqual([
      { type: "select-cancelled" },
      { type: "eruda-ready" },
      { type: "eruda-failed" },
    ]);
  });

  it("carries an eruda-failed reason when the page sends one", () => {
    const { events, deliver } = harness();
    deliver({
      source: "paseo-browser-bridge",
      type: "eruda-failed",
      payload: { reason: "script-load-failed" },
    });
    expect(events).toEqual([{ type: "eruda-failed", reason: "script-load-failed" }]);
  });
});
