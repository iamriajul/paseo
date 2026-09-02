import type { BridgeEvent } from "./web-bridge";

// Toolbar state for the web pane's iframe, reconciling two navigation models:
// a proxied preview URL carries the injected bridge and reports its own history
// (including in-page SPA routes the parent cannot see), while a direct URL has
// no bridge at all and only the parent's own URL-bar moves are observable.
// Pure by design — no window, no timers, no store.

export interface WebNavigationState {
  displayUrl: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  bridgeReady: boolean;
  // Parent-side history, used only while no bridge is reporting. In-page
  // navigation is invisible from here, so this tracks URL-bar moves alone.
  stack: readonly string[];
  index: number;
  // Stale-message guard. Internal to the reducer; no consumer reads these.
  lastDocId: string | null;
  lastSeq: number;
}

export type WebNavigationAction =
  | { type: "bridge"; event: BridgeEvent }
  | { type: "user-navigate"; url: string }
  | { type: "user-back" }
  | { type: "user-forward" }
  | { type: "reset"; url: string };

export function createWebNavigationState(url: string): WebNavigationState {
  return {
    displayUrl: url,
    title: "",
    canGoBack: false,
    canGoForward: false,
    bridgeReady: false,
    stack: [url],
    index: 0,
    lastDocId: null,
    lastSeq: 0,
  };
}

function movedTo(state: WebNavigationState, index: number): WebNavigationState {
  return {
    ...state,
    displayUrl: state.stack[index] ?? state.displayUrl,
    index,
    canGoBack: index > 0,
    canGoForward: index < state.stack.length - 1,
  };
}

export function webNavigationReducer(
  state: WebNavigationState,
  action: WebNavigationAction,
): WebNavigationState {
  switch (action.type) {
    // Pointing the iframe at a new URL ends any bridge session, so this rebuilds
    // the state rather than overwriting the displayed URL: a kept `bridgeReady`
    // or `lastSeq` would leave the toolbar trusting a bridge that is gone.
    case "reset":
      return createWebNavigationState(action.url);

    // Re-pointing the frame ends any bridge session too — the proxy injects no
    // bridge into another origin — so this clears the same bridge fields `reset`
    // does while keeping the parent stack, which is the half that still applies.
    // Leaving `bridgeReady` set would route back/forward into a dead session.
    case "user-navigate": {
      const stack = [...state.stack.slice(0, state.index + 1), action.url];
      return movedTo(
        { ...state, stack, bridgeReady: false, lastDocId: null, lastSeq: 0 },
        stack.length - 1,
      );
    }

    case "user-back":
      return state.index > 0 ? movedTo(state, state.index - 1) : state;

    case "user-forward":
      return state.index < state.stack.length - 1 ? movedTo(state, state.index + 1) : state;

    case "bridge": {
      const event = action.event;
      if (event.type === "ready") {
        // Only a *new* document reopens the seq guard. A `ready` can arrive
        // after its own document's first navigations, and dropping lastSeq to 0
        // there would let a stale message straight back through the seq check
        // below — the one thing that check exists to stop.
        return {
          ...state,
          bridgeReady: true,
          lastDocId: event.docId,
          lastSeq: state.lastDocId === event.docId ? state.lastSeq : 0,
        };
      }
      if (event.type !== "navigation") return state;

      // A new document restarts seq at 1, so only compare within one document.
      const sameDocument = state.lastDocId === event.docId;
      if (sameDocument && event.seq <= state.lastSeq) return state;

      return {
        ...state,
        bridgeReady: true,
        displayUrl: event.url,
        title: event.title,
        canGoBack: event.canGoBack,
        canGoForward: event.canGoForward,
        lastDocId: event.docId,
        lastSeq: event.seq,
      };
    }
  }
}
