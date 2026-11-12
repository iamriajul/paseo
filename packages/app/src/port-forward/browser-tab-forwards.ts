import { useBrowserStore } from "@/desktop/browser/store";
import { isLoopbackHttpUrl } from "@/utils/localhost-url";
import { getPortForwardController } from "./controller";
import type { PortForwardController } from "./types";

/**
 * Browser tabs with forwards on this phone. Android's Browser pane has no webview registration
 * that ends with the tab, as Electron's has, so the browser store decides instead.
 */
const forwardedTabs = new Set<string>();
let unsubscribe: (() => void) | null = null;

export function rememberBrowserTabForward(
  browserId: string,
  controller: PortForwardController | null = getPortForwardController(),
): void {
  forwardedTabs.add(browserId);
  unsubscribe ??= useBrowserStore.subscribe((state) => {
    stopForwardsOfEndedBrowserTabs(state.browsersById, controller);
  });
}

/**
 * Forwards belong to the tab's page: stops those of every tab that closed or left localhost
 * (its host's ports are no longer what it shows).
 */
export function stopForwardsOfEndedBrowserTabs(
  browsersById: Readonly<Record<string, { url: string }>>,
  controller: PortForwardController | null = getPortForwardController(),
): string[] {
  if (!controller) return [];
  const ended = Array.from(forwardedTabs).filter((browserId) => {
    const url = browsersById[browserId]?.url;
    return url === undefined || !isLoopbackHttpUrl(url);
  });
  for (const browserId of ended) {
    forwardedTabs.delete(browserId);
    void controller.stopAll(browserId).catch(() => {});
  }
  if (forwardedTabs.size === 0) {
    unsubscribe?.();
    unsubscribe = null;
  }
  return ended;
}
