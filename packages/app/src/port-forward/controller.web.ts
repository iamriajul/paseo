import { getDesktopHost } from "@/desktop/host";
import type { PortForwardController } from "./types";

/** Electron desktop: listeners in Electron main (browser-port-forward.ts). A plain browser has none. */
export function getPortForwardController(): PortForwardController | null {
  const bridge = getDesktopHost()?.browser;
  const { startPortForward, stopPortForward, listPortForwards } = bridge ?? {};
  if (!bridge || !startPortForward || !stopPortForward || !listPortForwards) return null;
  return {
    device: "computer",
    start: (input) =>
      startPortForward({
        browserId: input.browserId,
        ports: [...input.ports],
        fallbackToAnyPort: input.fallbackToAnyPort,
        ...(input.route ? { host: input.route } : {}),
      }),
    stop: (input) => stopPortForward(input),
    stopAll: async (browserId) => {
      await bridge.stopAllPortForwards?.(browserId);
    },
    list: (browserId) => listPortForwards(browserId),
  };
}
