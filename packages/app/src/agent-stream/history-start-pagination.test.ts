import { describe, expect, it } from "vitest";
import {
  abandonHistoryStartPaginationRequest,
  createHistoryStartPaginationState,
  evaluateHistoryStartPagination,
  isHistoryStartLoadingOperation,
  rearmHistoryStartPagination,
  settleHistoryStartPagination,
  type HistoryStartPaginationInput,
} from "./history-start-pagination";

function createArmedHistoryStartPaginationState() {
  return rearmHistoryStartPagination(createHistoryStartPaginationState());
}

const visibleHistoryStart: HistoryStartPaginationInput = {
  distanceFromHistoryStart: 0,
  contentFitsViewport: false,
  hasOlderHistory: true,
  isLoadingOlderHistory: false,
  isReady: true,
  progressKey: "epoch-1:20",
};

describe("history start pagination", () => {
  it("treats locally revealed history as progress before remote pagination", () => {
    const first = evaluateHistoryStartPagination(
      createArmedHistoryStartPaginationState(),
      visibleHistoryStart,
    );
    const localReveal = evaluateHistoryStartPagination(first.state, {
      ...visibleHistoryStart,
      progressKey: "epoch-1:20:local-60",
    });

    expect(first.shouldLoad).toBe(true);
    expect(localReveal.state).toEqual({
      status: "settling",
      loadedProgressKey: "epoch-1:20:local-60",
    });
  });
  it("waits for user scroll intent before loading", () => {
    const dormant = createHistoryStartPaginationState();
    const evaluated = evaluateHistoryStartPagination(dormant, visibleHistoryStart);

    expect(evaluated).toEqual({ state: { status: "dormant" }, shouldLoad: false });
  });

  it("loads without scroll intent when the content is too short to scroll", () => {
    const dormant = createHistoryStartPaginationState();
    const evaluated = evaluateHistoryStartPagination(dormant, {
      ...visibleHistoryStart,
      contentFitsViewport: true,
    });

    expect(evaluated).toEqual({
      state: { status: "loading", requestedProgressKey: "epoch-1:20", requestObserved: false },
      shouldLoad: true,
    });
  });

  it("loads again when a latch was set at an older position and the content cannot scroll", () => {
    const localTail = { ...visibleHistoryStart, contentFitsViewport: true, progressKey: "local:0" };
    const localReveal = evaluateHistoryStartPagination(createHistoryStartPaginationState(), {
      ...localTail,
      progressKey: "local:20",
    });
    const exhausted = settleHistoryStartPagination(
      evaluateHistoryStartPagination(localReveal.state, localTail).state,
      { ...localTail, hasOlderHistory: false },
    );
    const sameKey = evaluateHistoryStartPagination(exhausted.state, localTail);
    const remoteTail = evaluateHistoryStartPagination(exhausted.state, {
      ...localTail,
      progressKey: "epoch-1:87:0",
    });

    expect(exhausted.state.status).toBe("latched");
    expect(sameKey.shouldLoad).toBe(false);
    expect(remoteTail).toEqual({
      state: { status: "loading", requestedProgressKey: "epoch-1:87:0", requestObserved: false },
      shouldLoad: true,
    });
  });

  it("waits for anchored page geometry before authorizing another page", () => {
    const first = evaluateHistoryStartPagination(
      createArmedHistoryStartPaginationState(),
      visibleHistoryStart,
    );
    const inFlight = evaluateHistoryStartPagination(first.state, {
      ...visibleHistoryStart,
      isLoadingOlderHistory: true,
    });
    const pageApplied = evaluateHistoryStartPagination(inFlight.state, {
      ...visibleHistoryStart,
      isLoadingOlderHistory: true,
      progressKey: "epoch-1:10",
    });

    expect([first.shouldLoad, inFlight.shouldLoad, pageApplied.shouldLoad]).toEqual([
      true,
      false,
      false,
    ]);
    expect(pageApplied.state).toEqual({ status: "settling", loadedProgressKey: "epoch-1:10" });
  });

  it("loads one page each time anchored geometry leaves and returns to history start", () => {
    const first = evaluateHistoryStartPagination(
      createArmedHistoryStartPaginationState(),
      visibleHistoryStart,
    );
    const pageApplied = evaluateHistoryStartPagination(first.state, {
      ...visibleHistoryStart,
      progressKey: "epoch-1:10",
    });
    const settledAway = settleHistoryStartPagination(pageApplied.state, {
      ...visibleHistoryStart,
      distanceFromHistoryStart: 300,
      progressKey: "epoch-1:10",
    });
    const returned = evaluateHistoryStartPagination(settledAway.state, {
      ...visibleHistoryStart,
      progressKey: "epoch-1:10",
    });

    expect([
      first.shouldLoad,
      pageApplied.shouldLoad,
      settledAway.shouldLoad,
      returned.shouldLoad,
    ]).toEqual([true, false, false, true]);
  });

  it("continues the same loading operation when anchored geometry remains at history start", () => {
    const first = evaluateHistoryStartPagination(
      createArmedHistoryStartPaginationState(),
      visibleHistoryStart,
    );
    const pageApplied = evaluateHistoryStartPagination(first.state, {
      ...visibleHistoryStart,
      progressKey: "epoch-1:10",
    });
    const continued = settleHistoryStartPagination(pageApplied.state, {
      ...visibleHistoryStart,
      progressKey: "epoch-1:10",
    });

    expect(continued.shouldLoad).toBe(true);
    expect(isHistoryStartLoadingOperation(first.state)).toBe(true);
    expect(isHistoryStartLoadingOperation(pageApplied.state)).toBe(true);
    expect(isHistoryStartLoadingOperation(continued.state)).toBe(true);
  });

  it("latches a request that finishes without cursor progress", () => {
    const first = evaluateHistoryStartPagination(
      createArmedHistoryStartPaginationState(),
      visibleHistoryStart,
    );
    const inFlight = evaluateHistoryStartPagination(first.state, {
      ...visibleHistoryStart,
      isLoadingOlderHistory: true,
    });
    const finished = evaluateHistoryStartPagination(inFlight.state, visibleHistoryStart);
    const duplicate = evaluateHistoryStartPagination(finished.state, visibleHistoryStart);
    const away = evaluateHistoryStartPagination(duplicate.state, {
      ...visibleHistoryStart,
      distanceFromHistoryStart: 300,
    });

    expect(finished.state).toEqual({ status: "latched", progressKey: "epoch-1:20" });
    expect([finished.shouldLoad, duplicate.shouldLoad, away.shouldLoad]).toEqual([
      false,
      false,
      false,
    ]);
    expect(away.state).toEqual({ status: "ready" });
  });

  it("allows another user attempt after a request finishes without progress", () => {
    const first = evaluateHistoryStartPagination(
      createArmedHistoryStartPaginationState(),
      visibleHistoryStart,
    );
    const inFlight = evaluateHistoryStartPagination(first.state, {
      ...visibleHistoryStart,
      isLoadingOlderHistory: true,
    });
    const failed = evaluateHistoryStartPagination(inFlight.state, visibleHistoryStart);
    const retried = evaluateHistoryStartPagination(
      rearmHistoryStartPagination(failed.state),
      visibleHistoryStart,
    );

    expect(failed.state).toEqual({ status: "latched", progressKey: "epoch-1:20" });
    expect(retried.shouldLoad).toBe(true);
  });

  it("latches an attempt that becomes invalid before entering flight", () => {
    const requested = evaluateHistoryStartPagination(
      createArmedHistoryStartPaginationState(),
      visibleHistoryStart,
    );

    expect(abandonHistoryStartPaginationRequest(requested.state, "epoch-1:20")).toEqual({
      status: "latched",
      progressKey: "epoch-1:20",
    });
  });

  it("does not mistake repeated edge observations for a finished request", () => {
    const first = evaluateHistoryStartPagination(
      createArmedHistoryStartPaginationState(),
      visibleHistoryStart,
    );
    const repeated = evaluateHistoryStartPagination(first.state, visibleHistoryStart);

    expect(repeated.state).toBe(first.state);
    expect(repeated.shouldLoad).toBe(false);
  });

  it("waits while history loading is unavailable or already active", () => {
    const state = createArmedHistoryStartPaginationState();

    expect([
      evaluateHistoryStartPagination(state, { ...visibleHistoryStart, isReady: false }).shouldLoad,
      evaluateHistoryStartPagination(state, { ...visibleHistoryStart, hasOlderHistory: false })
        .shouldLoad,
      evaluateHistoryStartPagination(state, { ...visibleHistoryStart, isLoadingOlderHistory: true })
        .shouldLoad,
      evaluateHistoryStartPagination(state, { ...visibleHistoryStart, progressKey: null })
        .shouldLoad,
    ]).toEqual([false, false, false, false]);
  });
});
