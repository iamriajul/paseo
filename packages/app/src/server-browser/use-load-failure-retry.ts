import { useEffect, useRef } from "react";
import {
  autoRetryDelaySeconds,
  isAutoRetryableLoadError,
} from "@/desktop/browser/pane/load-failure";

/**
 * The desktop Browser's automatic retry, for a server tab: a load that failed because nothing
 * answered yet (a dev server still starting) is retried with backoff (2 s doubling to 30 s) while
 * the tab is on screen and the host is connected, and at once when the host reconnects. Returns
 * the seconds until the next retry, or null when it waits for the user.
 */
export function useLoadFailureRetry(input: {
  /** The failed load's Chromium error, or null when the tab shows no failure. */
  failure: { url: string; errorText?: string } | null;
  active: boolean;
  hostConnected: boolean;
  retry: () => void;
}): number | null {
  const { failure, active, hostConnected, retry } = input;
  const attemptRef = useRef(0);
  const retryRef = useRef(retry);
  retryRef.current = retry;
  const failureKey = failure ? `${failure.url}\n${failure.errorText ?? ""}` : null;
  if (failureKey === null) attemptRef.current = 0;

  const retryInSeconds =
    failure && active && hostConnected && isAutoRetryableLoadError(failure.errorText ?? "")
      ? autoRetryDelaySeconds(attemptRef.current + 1)
      : null;

  useEffect(() => {
    if (retryInSeconds === null) return undefined;
    const timer = setTimeout(() => {
      attemptRef.current += 1;
      retryRef.current();
    }, retryInSeconds * 1000);
    return () => clearTimeout(timer);
    // A new failure of the same load (the retry failed again) restarts the countdown.
  }, [retryInSeconds, failureKey, failure]);

  const wasConnectedRef = useRef(hostConnected);
  useEffect(() => {
    const reconnected = hostConnected && !wasConnectedRef.current;
    wasConnectedRef.current = hostConnected;
    if (reconnected && failureKey !== null) {
      attemptRef.current = 0;
      retryRef.current();
    }
  }, [hostConnected, failureKey]);

  return retryInSeconds;
}
