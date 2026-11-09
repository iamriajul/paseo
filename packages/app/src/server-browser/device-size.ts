import {
  browserDevicePresetIdForSize,
  getBrowserDevicePreset,
  type BrowserDeviceKind,
  type BrowserDeviceSizeId,
} from "@/desktop/browser/device-presets";

export interface ServerBrowserViewportSize {
  width: number;
  height: number;
  mobile: boolean;
}

/** The size the daemon gives every new tab, and so the one an agent's page was laid out at. */
export const SERVER_BROWSER_DEFAULT_VIEWPORT: ServerBrowserViewportSize = {
  width: 1280,
  height: 800,
  mobile: false,
};

/** The Browser panes' device sizes, plus the agents' default the server viewer starts at. */
export type ServerBrowserDeviceChoice = "default" | BrowserDeviceSizeId;

// The daemon's set_viewport bounds.
const MIN_SIDE = 200;
const MAX_SIDE = 4000;
// Under this a pane resize is a scrollbar or a border, not a new layout worth a page relayout.
const RESPONSIVE_SLACK_PX = 4;

function clampSide(value: number): number {
  return Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(value)));
}

/**
 * The viewport a choice sets. Phones and tablets emulate a mobile device (touch, the page's meta
 * viewport, 2x pixels), as Chrome's device mode does; Responsive fills the viewer at its CSS size.
 * Null for Responsive before the viewer has a size.
 */
export function viewportForDeviceChoice(
  choice: ServerBrowserDeviceChoice,
  surface: { width: number; height: number } | null,
): ServerBrowserViewportSize | null {
  if (choice === "default") return SERVER_BROWSER_DEFAULT_VIEWPORT;
  const preset = getBrowserDevicePreset(choice);
  if (preset.width === null || preset.height === null) {
    if (!surface || surface.width <= 0 || surface.height <= 0) return null;
    return { width: clampSide(surface.width), height: clampSide(surface.height), mobile: false };
  }
  return {
    width: preset.width,
    height: preset.height,
    mobile: preset.kind === "phone" || preset.kind === "tablet",
  };
}

/** Which choice the menu ticks: Responsive while this viewer follows its own size, else by size. */
export function selectedDeviceChoice(
  viewport: ServerBrowserViewportSize,
  responsive: boolean,
): ServerBrowserDeviceChoice | null {
  if (responsive) return "responsive";
  if (
    viewport.width === SERVER_BROWSER_DEFAULT_VIEWPORT.width &&
    viewport.height === SERVER_BROWSER_DEFAULT_VIEWPORT.height &&
    !viewport.mobile
  ) {
    return "default";
  }
  return browserDevicePresetIdForSize(viewport);
}

/** The icon the trigger shows for the tab's current size. */
export function deviceKindForViewport(
  viewport: ServerBrowserViewportSize,
  choice: ServerBrowserDeviceChoice | null,
): BrowserDeviceKind {
  if (choice === "default") return "desktop";
  if (choice) return getBrowserDevicePreset(choice).kind;
  return viewport.mobile ? "phone" : "desktop";
}

/** Whether a Responsive viewer's new size is worth relaying out the page. */
export function responsiveSizeChanged(
  current: { width: number; height: number },
  next: ServerBrowserViewportSize,
): boolean {
  return (
    Math.abs(current.width - next.width) > RESPONSIVE_SLACK_PX ||
    Math.abs(current.height - next.height) > RESPONSIVE_SLACK_PX
  );
}
