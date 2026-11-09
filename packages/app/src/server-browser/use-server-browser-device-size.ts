import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  responsiveSizeChanged,
  selectedDeviceChoice,
  viewportForDeviceChoice,
  type ServerBrowserDeviceChoice,
  type ServerBrowserViewportSize,
} from "./device-size";

// A drag resizes the pane many times a second; the page relays out once it settles.
const RESPONSIVE_SETTLE_MS = 250;

function sameSize(a: ServerBrowserViewportSize, b: ServerBrowserViewportSize): boolean {
  return a.width === b.width && a.height === b.height && a.mobile === b.mobile;
}

export interface ServerBrowserDeviceSize {
  choice: ServerBrowserDeviceChoice | null;
  select(choice: ServerBrowserDeviceChoice): void;
  /** The viewer's CSS size, from the surface. */
  onSurfaceSize(size: { width: number; height: number }): void;
}

/**
 * The device size menu of one viewer. A preset is the tab's size for everyone. Responsive is this
 * viewer's: it sizes the page to this pane and follows its resizes until the tab's size changes to
 * one this viewer did not ask for (another viewer's choice), so two viewers never fight over it.
 */
export function useServerBrowserDeviceSize(input: {
  client: DaemonClient | null;
  browserId: string;
  viewport: ServerBrowserViewportSize;
  run: (action: () => Promise<void> | undefined) => void;
}): ServerBrowserDeviceSize {
  const { client, browserId, viewport, run } = input;
  const [responsive, setResponsive] = useState(false);
  const [surface, setSurface] = useState<{ width: number; height: number } | null>(null);
  // The size this viewer asked for while Responsive, until the tab reports it.
  const requestedRef = useRef<ServerBrowserViewportSize | null>(null);

  const setViewport = useCallback(
    (next: ServerBrowserViewportSize) =>
      run(() => client?.serverBrowserSetViewport(browserId, next)),
    [browserId, client, run],
  );

  const select = useCallback(
    (choice: ServerBrowserDeviceChoice) => {
      const next = viewportForDeviceChoice(choice, surface);
      setResponsive(choice === "responsive");
      requestedRef.current = choice === "responsive" ? next : null;
      if (next) setViewport(next);
    },
    [setViewport, surface],
  );

  const onSurfaceSize = useCallback((size: { width: number; height: number }) => {
    setSurface((previous) =>
      previous &&
      Math.abs(previous.width - size.width) < 1 &&
      Math.abs(previous.height - size.height) < 1
        ? previous
        : size,
    );
  }, []);

  const { width, height, mobile } = viewport;
  useEffect(() => {
    if (!responsive) return;
    const requested = requestedRef.current;
    const current = { width, height, mobile };
    if (requested && sameSize(current, requested)) {
      requestedRef.current = null;
      return;
    }
    // Still waiting for this viewer's own size, or someone else picked one.
    if (!requested) setResponsive(false);
  }, [height, mobile, responsive, width]);

  useEffect(() => {
    if (!responsive) return;
    const next = viewportForDeviceChoice("responsive", surface);
    const target = requestedRef.current ?? { width, height };
    if (!next || !responsiveSizeChanged(target, next)) return;
    const timer = setTimeout(() => {
      requestedRef.current = next;
      setViewport(next);
    }, RESPONSIVE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [height, responsive, setViewport, surface, width]);

  return { choice: selectedDeviceChoice(viewport, responsive), select, onSurfaceSize };
}
