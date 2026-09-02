import { describe, expect, it } from "vitest";
import {
  applyWebNavigation,
  createWebNavigationState,
  webNavigationReducer,
  type WebNavigationAction,
  type WebNavigationState,
} from "./web-navigation";

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

  // No `ready` precedes this one on purpose: a navigation message is itself
  // proof of a live bridge, and bridgeReady is the value Task 11 branches on.
  it("takes url, title and history flags from the bridge", () => {
    const state = webNavigationReducer(
      createWebNavigationState(START),
      nav({
        url: "http://localhost:3000/about",
        title: "About",
        canGoBack: true,
        canGoForward: true,
      }),
    );
    expect(state.displayUrl).toBe("http://localhost:3000/about");
    expect(state.title).toBe("About");
    expect(state.canGoBack).toBe(true);
    expect(state.canGoForward).toBe(true);
    expect(state.bridgeReady).toBe(true);
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
    expect(state.title).toBe("Home");
    state = webNavigationReducer(state, { type: "reset", url: "https://other.example" });
    // Same reason as user-navigate: no bridge will ever correct a kept title.
    expect(state.title).toBe("");
    expect(state.stack).toEqual(["https://other.example"]);
    expect(state.index).toBe(0);
    expect(state.canGoBack).toBe(false);
    state = webNavigationReducer(state, nav({ seq: 1, url: "https://other.example/next" }));
    expect(state.displayUrl).toBe("https://other.example/next");
  });

  // A URL-bar move can leave the preview origin, and the proxy injects no bridge
  // into another origin. Keeping bridgeReady set would route back/forward into
  // bridge.send against a session that is already gone.
  it("ends the bridge session when the user navigates the url bar", () => {
    let state = webNavigationReducer(
      createWebNavigationState(START),
      nav({ seq: 4, url: "http://localhost:3000/b" }),
    );
    expect(state.bridgeReady).toBe(true);
    // Asserted before the move so the title check below cannot pass vacuously.
    expect(state.title).toBe("Home");
    state = webNavigationReducer(state, { type: "user-navigate", url: "https://other.example" });
    expect(state.bridgeReady).toBe(false);
    // A direct URL has no bridge to correct a stale title, and Task 11 feeds
    // this straight into updateBrowser({ title }) — so the tab would carry the
    // previous page's name indefinitely.
    expect(state.title).toBe("");
    // ...and the guard no longer holds the dead document's seq.
    state = webNavigationReducer(state, nav({ seq: 1, url: "https://other.example/next" }));
    expect(state.displayUrl).toBe("https://other.example/next");
  });

  // `ready` can arrive after its own document has already reported navigations.
  it("keeps the seq guard when ready repeats the current document", () => {
    let state = webNavigationReducer(
      createWebNavigationState(START),
      nav({ docId: "d2", seq: 3, url: "/three" }),
    );
    state = webNavigationReducer(state, { type: "bridge", event: { type: "ready", docId: "d2" } });
    state = webNavigationReducer(state, nav({ docId: "d2", seq: 1, url: "/stale" }));
    expect(state.displayUrl).toBe("/three");
  });

  it("reopens the seq guard when ready announces a new document", () => {
    let state = webNavigationReducer(
      createWebNavigationState(START),
      nav({ docId: "d2", seq: 3, url: "/three" }),
    );
    state = webNavigationReducer(state, { type: "bridge", event: { type: "ready", docId: "d3" } });
    state = webNavigationReducer(state, nav({ docId: "d3", seq: 1, url: "/fresh" }));
    expect(state.displayUrl).toBe("/fresh");
  });

  it("stays put when there is nowhere to go back or forward", () => {
    const start = createWebNavigationState(START);
    expect(webNavigationReducer(start, { type: "user-back" })).toBe(start);
    expect(webNavigationReducer(start, { type: "user-forward" })).toBe(start);
  });
});

describe("applyWebNavigation", () => {
  // Three URL-bar moves, so index 1 has somewhere to go in both directions.
  function threeDeep(): WebNavigationState {
    let state = createWebNavigationState(START);
    state = webNavigationReducer(state, { type: "user-navigate", url: "https://a.example" });
    state = webNavigationReducer(state, { type: "user-navigate", url: "https://b.example" });
    return webNavigationReducer(state, { type: "user-back" });
  }

  // The cross-check. The record the pane writes has to be what the reducer
  // actually produced, so this runs the reducer separately and compares —
  // rather than restating the arithmetic, which would reproduce the very
  // mistake it is meant to catch. Reintroducing a hand-computed destination in
  // applyWebNavigation fails this for whichever term drifts.
  function expectRecordMatchesReducer(
    state: WebNavigationState,
    action: WebNavigationAction,
  ): void {
    const applied = applyWebNavigation(state, action);
    const reduced = webNavigationReducer(state, action);
    expect(applied).not.toBeNull();
    expect(applied?.record).toEqual({
      url: reduced.displayUrl,
      title: reduced.title,
      canGoBack: reduced.canGoBack,
      canGoForward: reduced.canGoForward,
    });
  }

  it("matches the reducer for a url-bar navigation", () => {
    expectRecordMatchesReducer(threeDeep(), { type: "user-navigate", url: "https://c.example" });
  });

  it("matches the reducer going back", () => {
    expectRecordMatchesReducer(threeDeep(), { type: "user-back" });
  });

  it("matches the reducer going forward", () => {
    expectRecordMatchesReducer(threeDeep(), { type: "user-forward" });
  });

  // Lands on index 1 of a 3-entry stack — the one position where "there is
  // exactly one entry ahead" is true. Without a case here, an off-by-one in
  // canGoForward reads the same as the real value everywhere else in this file.
  it("matches the reducer moving forward into the middle of the stack", () => {
    let state = createWebNavigationState(START);
    state = webNavigationReducer(state, { type: "user-navigate", url: "https://a.example" });
    state = webNavigationReducer(state, { type: "user-navigate", url: "https://b.example" });
    state = webNavigationReducer(state, { type: "user-back" });
    state = webNavigationReducer(state, { type: "user-back" });
    expect(state.index).toBe(0);
    expectRecordMatchesReducer(state, { type: "user-forward" });
  });

  it("matches the reducer from the bottom of the stack", () => {
    expectRecordMatchesReducer(createWebNavigationState(START), {
      type: "user-navigate",
      url: "https://a.example",
    });
  });

  // The values, not just the agreement: a submit always leaves somewhere to go
  // back to, which the pane once wrote as canGoBack: false.
  it("reports a way back and none forward after a url-bar navigation", () => {
    const applied = applyWebNavigation(createWebNavigationState(START), {
      type: "user-navigate",
      url: "https://a.example",
    });
    expect(applied?.record).toEqual({
      url: "https://a.example",
      title: "",
      canGoBack: true,
      canGoForward: false,
    });
  });

  it("refuses to move back from the bottom of the stack", () => {
    // Boundary: the reducer returns the identical state, so there is no record
    // to write. The pane must not write one for a move that did not happen.
    expect(applyWebNavigation(createWebNavigationState(START), { type: "user-back" })).toBeNull();
  });

  it("refuses to move forward from the top of the stack", () => {
    let state = createWebNavigationState(START);
    state = webNavigationReducer(state, { type: "user-navigate", url: "https://a.example" });
    expect(applyWebNavigation(state, { type: "user-forward" })).toBeNull();
  });
});
