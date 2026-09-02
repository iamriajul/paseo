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

  // An ordinary click on an off-origin link inside the frame. Nothing arrives
  // from the bridge again, and the pane only learns of it from the frame's
  // `load` event, so the reducer has to be told rather than able to notice.
  it("ends the bridge session when the frame leaves the preview origin", () => {
    let state = webNavigationReducer(
      createWebNavigationState(START),
      nav({ seq: 4, url: "http://localhost:3000/b" }),
    );
    expect(state.bridgeReady).toBe(true);
    expect(state.title).toBe("Home");
    state = webNavigationReducer(state, { type: "bridge-lost" });
    expect(state.bridgeReady).toBe(false);
    expect(state.bridgeLost).toBe(true);
    // Same reason as user-navigate: no bridge will ever correct a kept title,
    // and the pane feeds it straight into updateBrowser({ title }).
    expect(state.title).toBe("");
    // ...and the guard no longer holds the dead document's seq, so a frame that
    // comes back to the preview origin is heard again.
    state = webNavigationReducer(state, nav({ seq: 1, url: "http://localhost:3000/c" }));
    expect(state.displayUrl).toBe("http://localhost:3000/c");
  });

  // The sharp half. The bridge reports the *page's* history; the parent stack
  // knows only URL-bar moves, and here it has none. Carrying the bridge's flags
  // across leaves Back enabled over a stack that will refuse to move — the lit
  // control that does nothing, which is the failure this whole action prevents.
  it("recomputes the history flags from the parent stack when the bridge is lost", () => {
    let state = createWebNavigationState(START);
    state = webNavigationReducer(
      state,
      nav({ url: "http://localhost:3000/deep", canGoBack: true, canGoForward: true }),
    );
    expect(state.canGoBack).toBe(true);
    expect(state.canGoForward).toBe(true);
    state = webNavigationReducer(state, { type: "bridge-lost" });
    expect(state.canGoBack).toBe(false);
    expect(state.canGoForward).toBe(false);
    // And the address bar falls back to where the frame was pointed, which is
    // the only URL the parent still knows to be true.
    expect(state.displayUrl).toBe(START);
    expect(webNavigationReducer(state, { type: "user-back" })).toBe(state);
  });

  // The parent stack is the half that never depended on the bridge, so losing
  // the bridge must not cost the URL-bar history the way `reset` does.
  it("keeps the parent stack when the bridge is lost", () => {
    let state = createWebNavigationState(START);
    state = webNavigationReducer(state, { type: "user-navigate", url: "http://localhost:3000/a" });
    state = webNavigationReducer(state, nav({ url: "http://localhost:3000/a/deep" }));
    state = webNavigationReducer(state, { type: "bridge-lost" });
    expect(state.stack).toEqual([START, "http://localhost:3000/a"]);
    expect(state.index).toBe(1);
    expect(state.canGoBack).toBe(true);
    state = webNavigationReducer(state, { type: "user-back" });
    expect(state.displayUrl).toBe(START);
  });

  // Direct URLs take this path on every single page load, and a state change
  // per load would re-render the toolbar for nothing.
  it("leaves a state with no live bridge untouched", () => {
    const start = createWebNavigationState(START);
    expect(webNavigationReducer(start, { type: "bridge-lost" })).toBe(start);
    const navigated = webNavigationReducer(start, {
      type: "user-navigate",
      url: "https://other.example",
    });
    expect(webNavigationReducer(navigated, { type: "bridge-lost" })).toBe(navigated);
  });

  // `bridgeLost` says "devtools are gone from where the frame is now", which a
  // frame back on an announcing document is not. Both true at once would put
  // the notice under a live bridge.
  it("clears bridgeLost when a document announces itself again", () => {
    let state = webNavigationReducer(createWebNavigationState(START), nav({ seq: 2 }));
    state = webNavigationReducer(state, { type: "bridge-lost" });
    expect(state.bridgeLost).toBe(true);
    state = webNavigationReducer(state, { type: "bridge", event: { type: "ready", docId: "d9" } });
    expect(state.bridgeLost).toBe(false);
    expect(state.bridgeReady).toBe(true);
  });

  // A `navigation` message is itself proof of a live bridge — the reducer sets
  // bridgeReady from it with no `ready` in front — so it has to clear the flag
  // on that path too, or the invariant holds only for one of the two.
  it("clears bridgeLost when a navigation message arrives again", () => {
    let state = webNavigationReducer(createWebNavigationState(START), nav({ seq: 2 }));
    state = webNavigationReducer(state, { type: "bridge-lost" });
    state = webNavigationReducer(state, nav({ docId: "d2", seq: 1, url: "/back-again" }));
    expect(state.bridgeLost).toBe(false);
    expect(state.bridgeReady).toBe(true);
  });

  // Re-pointing the frame is a fresh start, not a continuation of the loss.
  it("clears bridgeLost when the user navigates the url bar", () => {
    let state = webNavigationReducer(createWebNavigationState(START), nav({ seq: 2 }));
    state = webNavigationReducer(state, { type: "bridge-lost" });
    state = webNavigationReducer(state, { type: "user-navigate", url: "https://other.example" });
    expect(state.bridgeLost).toBe(false);
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

  // The record has to follow a lost bridge for the same reason it follows a
  // url-bar move: on a direct URL nothing corrects it afterwards, and the tab
  // label, tooltip and persisted url all read from it.
  it("matches the reducer when the bridge is lost", () => {
    let state = createWebNavigationState(START);
    state = webNavigationReducer(state, { type: "user-navigate", url: "https://a.example" });
    state = webNavigationReducer(state, {
      type: "bridge",
      event: {
        type: "navigation",
        docId: "d1",
        seq: 1,
        url: "https://a.example/deep",
        title: "Deep",
        canGoBack: true,
        canGoForward: true,
      },
    });
    expectRecordMatchesReducer(state, { type: "bridge-lost" });
  });

  it("refuses a lost-bridge write when there was no bridge", () => {
    // Every load on a direct URL arrives here. Writing the record each time
    // would republish the same values and, worse, claim a change happened.
    expect(applyWebNavigation(createWebNavigationState(START), { type: "bridge-lost" })).toBeNull();
  });

  it("refuses to move forward from the top of the stack", () => {
    let state = createWebNavigationState(START);
    state = webNavigationReducer(state, { type: "user-navigate", url: "https://a.example" });
    expect(applyWebNavigation(state, { type: "user-forward" })).toBeNull();
  });
});
