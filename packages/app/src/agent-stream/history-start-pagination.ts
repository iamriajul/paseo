export const HISTORY_START_THRESHOLD_PX = 96;

export type HistoryStartPaginationState =
  | { status: "dormant" }
  | { status: "ready" }
  | { status: "loading"; requestedProgressKey: string; requestObserved: boolean }
  | { status: "settling"; loadedProgressKey: string }
  | { status: "latched"; progressKey: string | null };

export interface HistoryStartPaginationInput {
  distanceFromHistoryStart: number;
  contentFitsViewport: boolean;
  hasOlderHistory: boolean;
  isLoadingOlderHistory: boolean;
  isReady: boolean;
  progressKey: string | null;
}

export interface HistoryStartPaginationTransition {
  state: HistoryStartPaginationState;
  shouldLoad: boolean;
}

export function createHistoryStartPaginationState(): HistoryStartPaginationState {
  return { status: "dormant" };
}

export function isHistoryStartLoadingOperation(state: HistoryStartPaginationState): boolean {
  return state.status === "loading" || state.status === "settling";
}

export function rearmHistoryStartPagination(
  state: HistoryStartPaginationState,
): HistoryStartPaginationState {
  return state.status === "dormant" || state.status === "latched" ? { status: "ready" } : state;
}

export function abandonHistoryStartPaginationRequest(
  state: HistoryStartPaginationState,
  requestedProgressKey: string,
): HistoryStartPaginationState {
  if (
    state.status !== "loading" ||
    state.requestObserved ||
    state.requestedProgressKey !== requestedProgressKey
  ) {
    return state;
  }
  return { status: "latched", progressKey: requestedProgressKey };
}

// Content that fits the viewport cannot be scrolled, and Android delivers no drag events for
// it, so a list waiting for scroll intent would wait forever. A latch only means no progress at
// the position it was set, so new history (a fresh tail after the cached one) lifts it.
function awaitsScrollIntent(
  state: HistoryStartPaginationState,
  input: HistoryStartPaginationInput,
): boolean {
  if (state.status === "dormant") {
    return !input.contentFitsViewport;
  }
  if (state.status === "latched") {
    return !input.contentFitsViewport || input.progressKey === state.progressKey;
  }
  return false;
}

function evaluateLoadingHistoryStart(
  state: Extract<HistoryStartPaginationState, { status: "loading" }>,
  input: HistoryStartPaginationInput,
): HistoryStartPaginationTransition {
  if (input.progressKey !== null && input.progressKey !== state.requestedProgressKey) {
    return {
      state: { status: "settling", loadedProgressKey: input.progressKey },
      shouldLoad: false,
    };
  }
  if (input.isLoadingOlderHistory && !state.requestObserved) {
    return { state: { ...state, requestObserved: true }, shouldLoad: false };
  }
  if (!input.isLoadingOlderHistory && !input.hasOlderHistory) {
    return { state: { status: "latched", progressKey: input.progressKey }, shouldLoad: false };
  }
  if (
    state.requestObserved &&
    !input.isLoadingOlderHistory &&
    input.progressKey === state.requestedProgressKey
  ) {
    return { state: { status: "latched", progressKey: input.progressKey }, shouldLoad: false };
  }
  return { state, shouldLoad: false };
}

export function evaluateHistoryStartPagination(
  state: HistoryStartPaginationState,
  input: HistoryStartPaginationInput,
): HistoryStartPaginationTransition {
  if (state.status === "dormant" && awaitsScrollIntent(state, input)) {
    return { state, shouldLoad: false };
  }
  if (state.status === "loading") {
    return evaluateLoadingHistoryStart(state, input);
  }

  if (state.status === "settling") {
    return { state, shouldLoad: false };
  }

  const isAtHistoryStart = input.distanceFromHistoryStart <= HISTORY_START_THRESHOLD_PX;
  if (!isAtHistoryStart) {
    return state.status === "ready"
      ? { state, shouldLoad: false }
      : { state: { status: "ready" }, shouldLoad: false };
  }
  if (
    awaitsScrollIntent(state, input) ||
    !input.isReady ||
    !input.hasOlderHistory ||
    input.isLoadingOlderHistory ||
    input.progressKey === null
  ) {
    return { state, shouldLoad: false };
  }
  return {
    state: {
      status: "loading",
      requestedProgressKey: input.progressKey,
      requestObserved: false,
    },
    shouldLoad: true,
  };
}

export function settleHistoryStartPagination(
  state: HistoryStartPaginationState,
  input: HistoryStartPaginationInput,
): HistoryStartPaginationTransition {
  if (state.status !== "settling") {
    return { state, shouldLoad: false };
  }
  const isAtHistoryStart = input.distanceFromHistoryStart <= HISTORY_START_THRESHOLD_PX;
  if (
    !isAtHistoryStart ||
    !input.isReady ||
    !input.hasOlderHistory ||
    input.isLoadingOlderHistory ||
    input.progressKey === null
  ) {
    return {
      state: isAtHistoryStart
        ? { status: "latched", progressKey: input.progressKey }
        : { status: "ready" },
      shouldLoad: false,
    };
  }
  return {
    state: {
      status: "loading",
      requestedProgressKey: input.progressKey,
      requestObserved: false,
    },
    shouldLoad: true,
  };
}
