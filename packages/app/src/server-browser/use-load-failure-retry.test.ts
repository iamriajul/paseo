// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLoadFailureRetry } from "./use-load-failure-retry";

type Failure = { url: string; errorText?: string } | null;
const refused = { url: "http://localhost:5173/", errorText: "net::ERR_CONNECTION_REFUSED" };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useLoadFailureRetry", () => {
  it("retries a refused load with backoff while the tab is on screen", () => {
    const retry = vi.fn();
    const { result, rerender } = renderHook(
      (props: { failure: Failure }) =>
        useLoadFailureRetry({ failure: props.failure, active: true, hostConnected: true, retry }),
      { initialProps: { failure: refused as Failure } },
    );
    expect(result.current).toBe(2);
    vi.advanceTimersByTime(1999);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(1);

    // The retry failed again: the daemon reports a fresh copy of the same failure.
    rerender({ failure: { ...refused } });
    expect(result.current).toBe(4);
    vi.advanceTimersByTime(4000);
    expect(retry).toHaveBeenCalledTimes(2);

    // The page loaded: the backoff starts over for the next failure.
    rerender({ failure: null });
    expect(result.current).toBeNull();
    rerender({ failure: { ...refused } });
    expect(result.current).toBe(2);
  });

  it("waits for the user on an error retrying will not fix, off screen, or while disconnected", () => {
    const retry = vi.fn();
    const cases = [
      {
        failure: { url: refused.url, errorText: "net::ERR_NAME_NOT_RESOLVED" },
        active: true,
        hostConnected: true,
      },
      { failure: refused, active: false, hostConnected: true },
      { failure: refused, active: true, hostConnected: false },
    ];
    for (const props of cases) {
      const { result, unmount } = renderHook(() => useLoadFailureRetry({ ...props, retry }));
      expect(result.current).toBeNull();
      unmount();
    }
    vi.advanceTimersByTime(60_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it("retries at once when the host reconnects", () => {
    const retry = vi.fn();
    const { rerender } = renderHook(
      (props: { hostConnected: boolean }) =>
        useLoadFailureRetry({
          failure: refused,
          active: true,
          hostConnected: props.hostConnected,
          retry,
        }),
      { initialProps: { hostConnected: false } },
    );
    expect(retry).not.toHaveBeenCalled();
    rerender({ hostConnected: true });
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
