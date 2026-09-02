import { describe, expect, it } from "vitest";
import { createWebNavigationState, webNavigationReducer } from "./web-navigation";

const START = "http://localhost:3000/";

function nav(overrides: Record<string, unknown> = {}) {
  return {
    type: "bridge" as const,
    event: {
      type: "navigation" as const,
      docId: "d1",
      seq: 1,
      url: START,
      title: "Home",
      canGoBack: false,
      canGoForward: false,
      ...overrides,
    },
  };
}

describe("webNavigationReducer", () => {
  it("starts with the initial url and no history", () => {
    const state = createWebNavigationState(START);
    expect(state.displayUrl).toBe(START);
    expect(state.canGoBack).toBe(false);
    expect(state.bridgeReady).toBe(false);
  });

  it("marks the bridge ready", () => {
    const state = webNavigationReducer(createWebNavigationState(START), {
      type: "bridge",
      event: { type: "ready", docId: "d1" },
    });
    expect(state.bridgeReady).toBe(true);
  });

  it("takes url, title and history flags from the bridge", () => {
    const state = webNavigationReducer(
      createWebNavigationState(START),
      nav({ url: "http://localhost:3000/about", title: "About", canGoBack: true }),
    );
    expect(state.displayUrl).toBe("http://localhost:3000/about");
    expect(state.title).toBe("About");
    expect(state.canGoBack).toBe(true);
  });

  // Messages can arrive out of order; a stale one would drag the URL bar
  // backwards after the user already moved on.
  it("ignores a navigation message with a lower seq", () => {
    let state = webNavigationReducer(
      createWebNavigationState(START),
      nav({ seq: 5, url: "/five" }),
    );
    state = webNavigationReducer(state, nav({ seq: 2, url: "/two" }));
    expect(state.displayUrl).toBe("/five");
  });

  it("accepts a lower seq from a new document", () => {
    let state = webNavigationReducer(
      createWebNavigationState(START),
      nav({ seq: 5, url: "/five" }),
    );
    state = webNavigationReducer(state, nav({ seq: 1, url: "/fresh", docId: "d2" }));
    expect(state.displayUrl).toBe("/fresh");
  });

  it("tracks user navigations in its own stack when there is no bridge", () => {
    let state = createWebNavigationState(START);
    state = webNavigationReducer(state, { type: "user-navigate", url: "https://a.example" });
    state = webNavigationReducer(state, { type: "user-navigate", url: "https://b.example" });
    expect(state.canGoBack).toBe(true);
    expect(state.canGoForward).toBe(false);
    state = webNavigationReducer(state, { type: "user-back" });
    expect(state.displayUrl).toBe("https://a.example");
    expect(state.canGoForward).toBe(true);
  });

  it("truncates the forward entries on a new navigation", () => {
    let state = createWebNavigationState(START);
    state = webNavigationReducer(state, { type: "user-navigate", url: "https://a.example" });
    state = webNavigationReducer(state, { type: "user-back" });
    state = webNavigationReducer(state, { type: "user-navigate", url: "https://c.example" });
    expect(state.canGoForward).toBe(false);
    expect(state.stack).toEqual([START, "https://c.example"]);
  });

  it("lets the bridge override the parent stack once it is ready", () => {
    let state = createWebNavigationState(START);
    state = webNavigationReducer(state, { type: "user-navigate", url: "http://localhost:3000/a" });
    state = webNavigationReducer(state, { type: "bridge", event: { type: "ready", docId: "d1" } });
    state = webNavigationReducer(state, nav({ url: "http://localhost:3000/b", canGoBack: true }));
    expect(state.displayUrl).toBe("http://localhost:3000/b");
    expect(state.canGoBack).toBe(true);
  });

  it("clears bridge state on reset", () => {
    let state = webNavigationReducer(createWebNavigationState(START), {
      type: "bridge",
      event: { type: "ready", docId: "d1" },
    });
    state = webNavigationReducer(state, { type: "reset", url: "https://other.example" });
    expect(state.bridgeReady).toBe(false);
    expect(state.displayUrl).toBe("https://other.example");
    expect(state.canGoBack).toBe(false);
  });

  // The test above starts from a state whose canGoBack was already false, so a
  // reset that only rewrote the flags would still pass it. Pointing the frame at
  // a new url ends the bridge session outright: the parent stack has to be
  // rebuilt, and the seq guard has to stop rejecting the next document.
  it("ends the bridge session on reset, not just the displayed url", () => {
    let state = createWebNavigationState(START);
    state = webNavigationReducer(state, { type: "user-navigate", url: "http://localhost:3000/a" });
    state = webNavigationReducer(state, nav({ seq: 9, url: "http://localhost:3000/b" }));
    state = webNavigationReducer(state, { type: "reset", url: "https://other.example" });
    expect(state.stack).toEqual(["https://other.example"]);
    expect(state.index).toBe(0);
    expect(state.canGoBack).toBe(false);
    state = webNavigationReducer(state, nav({ seq: 1, url: "https://other.example/next" }));
    expect(state.displayUrl).toBe("https://other.example/next");
  });

  it("stays put when there is nowhere to go back or forward", () => {
    const start = createWebNavigationState(START);
    expect(webNavigationReducer(start, { type: "user-back" })).toBe(start);
    expect(webNavigationReducer(start, { type: "user-forward" })).toBe(start);
  });
});
