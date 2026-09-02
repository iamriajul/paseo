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
  // The frame navigated off the preview origin and the bridge session ended
  // with it. Distinct from `!bridgeReady`, which is also the state of a frame
  // whose bridged document has simply not announced itself yet: only this one
  // means devtools and the picker are gone for as long as the frame stays where
  // it is. `bridgeLost` and `bridgeReady` are never both true.
  bridgeLost: boolean;
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
  | { type: "bridge-lost" }
  | { type: "reset"; url: string };

export function createWebNavigationState(url: string): WebNavigationState {
  return {
    displayUrl: url,
    title: "",
    canGoBack: false,
    canGoForward: false,
    bridgeReady: false,
    bridgeLost: false,
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

// The BrowserRecord fields a parent-side navigation implies. The pane has to
// write these at the moment it dispatches, and the obvious way — recomputing
// the destination index by hand — puts the same arithmetic in two places, where
// a change to `user-navigate`'s stack shape silently desynchronises the record
// from the toolbar. Running the reducer is the only way to be sure they agree,
// so that is what this does: no arithmetic here mirrors `movedTo`.
//
// Returns null when the reducer refuses the action. `movedTo` is only reached
// past the bounds guards, and a refusal returns the identical state object, so
// identity is the reducer's own answer to "did this move" rather than a second
// copy of its guards.
export interface WebNavigationRecord {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

export function applyWebNavigation(
  state: WebNavigationState,
  action: WebNavigationAction,
): { state: WebNavigationState; record: WebNavigationRecord } | null {
  const next = webNavigationReducer(state, action);
  if (next === state) {
    return null;
  }
  return {
    state: next,
    record: {
      url: next.displayUrl,
      title: next.title,
      canGoBack: next.canGoBack,
      canGoForward: next.canGoForward,
    },
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
    // Leaving `bridgeReady` set would route back/forward into a dead session, and
    // a kept `title` would name the previous page forever: a direct URL has no
    // bridge to correct it. Empty is the honest value for an unknown title.
    case "user-navigate": {
      const stack = [...state.stack.slice(0, state.index + 1), action.url];
      return movedTo(
        {
          ...state,
          stack,
          title: "",
          bridgeReady: false,
          bridgeLost: false,
          lastDocId: null,
          lastSeq: 0,
        },
        stack.length - 1,
      );
    }

    case "user-back":
      return state.index > 0 ? movedTo(state, state.index - 1) : state;

    case "user-forward":
      return state.index < state.stack.length - 1 ? movedTo(state, state.index + 1) : state;

    // The frame left the preview origin under its own steam — an ordinary click
    // on an off-origin link, the one navigation the pane cannot route through
    // `resolveWebBrowserSrc`. Nothing arrives from the bridge again, so without
    // this the toolbar would go on offering a history, a title and devtools that
    // belong to a document the frame is no longer showing.
    //
    // What survives is exactly what survives `user-navigate`: the parent stack,
    // which never depended on the bridge. `movedTo` at the current index
    // recomputes `displayUrl`, `canGoBack` and `canGoForward` from it, so back
    // and forward keep working on URL-bar moves instead of staying lit and
    // inert on the dead session's flags.
    //
    // Guarded on `bridgeReady`: a document that never announced itself has
    // nothing to lose, and returning the identical state keeps `load` events on
    // direct URLs — where every load takes this path — free of re-renders.
    case "bridge-lost":
      return state.bridgeReady
        ? movedTo(
            {
              ...state,
              title: "",
              bridgeReady: false,
              bridgeLost: true,
              lastDocId: null,
              lastSeq: 0,
            },
            state.index,
          )
        : state;

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
          bridgeLost: false,
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
        bridgeLost: false,
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
