import { setTimeout as delay } from "node:timers/promises";
import type { ServerBrowserElementSelection } from "@getpaseo/protocol/server-browser/rpc-schemas";
import { BRIDGE_SOURCE, COMMAND_SOURCE } from "../browser-preview/inject/protocol.js";
import { SELECTOR_SCRIPT } from "../browser-preview/inject/selector-script.js";
import type { TabContents } from "./engine/service.js";

/** The slice of a tab the picker needs; every server browser engine's TabContents has it. */
export type PickerPage = Pick<TabContents, "executeJavaScript" | "sendDebugCommand">;

export type PickOutcome =
  | {
      outcome: "selected";
      selection: ServerBrowserElementSelection;
      screenshot?: { data: string; mimeType: "image/png" };
    }
  | { outcome: "cancelled" };

const POLL_MS = 80;
const HANDLE = "__paseoServerPick";

// The web pane's selector script runs unchanged: it posts to window.parent, which is the page
// itself in a top-level tab, and it takes its start command from window.parent too. This
// adapter is the parent: it relays the start and keeps the answer for the daemon to poll.
const ARM_SCRIPT = `(function() {
  var BRIDGE = ${JSON.stringify(BRIDGE_SOURCE)};
  var COMMAND = ${JSON.stringify(COMMAND_SOURCE)};
  var previous = window[${JSON.stringify(HANDLE)}];
  if (previous) previous.dispose();
  var answer = null;
  function onMessage(event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== BRIDGE) return;
    if (data.type === 'selection') answer = { outcome: 'selected', selection: data.payload };
    else if (data.type === 'select-cancelled') answer = { outcome: 'cancelled' };
  }
  window.addEventListener('message', onMessage);
  window[${JSON.stringify(HANDLE)}] = {
    take: function() { return answer ? JSON.stringify(answer) : null; },
    dispose: function() {
      window.removeEventListener('message', onMessage);
      delete window[${JSON.stringify(HANDLE)}];
    }
  };
  window.postMessage({ source: COMMAND, command: 'start-select' }, '*');
  return true;
})()`;

// "gone": a navigation replaced the document, and the picker with it.
const POLL_SCRIPT = `(function() {
  var handle = window[${JSON.stringify(HANDLE)}];
  if (!handle) return 'gone';
  var answer = handle.take();
  if (answer) handle.dispose();
  return answer;
})()`;

const DISARM_SCRIPT = `(function() {
  var handle = window[${JSON.stringify(HANDLE)}];
  if (handle) handle.dispose();
  if (window.__paseoSelector) window.__paseoSelector.destroy();
  return true;
})()`;

interface ActivePick {
  cancel: () => void;
  /** Settles once the pick has disarmed the page. */
  done: Promise<unknown>;
}

// One pick per tab across every client: a second start cancels the first.
const active = new WeakMap<PickerPage, ActivePick>();

/**
 * Arms the selector in the page and resolves when the user clicks an element (with the element's
 * visible part cropped as a PNG), presses Escape in the page, navigates away, or cancels.
 */
export async function pickElement(page: PickerPage, signal?: AbortSignal): Promise<PickOutcome> {
  const previous = active.get(page);
  let cancelled = false;
  let wake = () => {};
  const self: ActivePick = {
    cancel: () => {
      cancelled = true;
      wake();
    },
    done: Promise.resolve(),
  };
  const run = async (): Promise<PickOutcome> => {
    if (previous) {
      // Its disarm would otherwise tear down the overlay this pick is about to arm.
      previous.cancel();
      await previous.done.catch(() => {});
    }
    return poll(
      page,
      () => cancelled,
      (wakeUp) => {
        wake = wakeUp;
      },
    );
  };
  const onAbort = () => self.cancel();
  signal?.addEventListener("abort", onAbort);
  if (signal?.aborted) self.cancel();
  const result = run();
  self.done = result;
  active.set(page, self);
  try {
    return await result;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (active.get(page) === self) active.delete(page);
  }
}

async function poll(
  page: PickerPage,
  isCancelled: () => boolean,
  onWait: (wake: () => void) => void,
): Promise<PickOutcome> {
  if (isCancelled()) return { outcome: "cancelled" };
  await page.executeJavaScript(SELECTOR_SCRIPT);
  await page.executeJavaScript(ARM_SCRIPT);
  for (;;) {
    if (isCancelled()) {
      await page.executeJavaScript(DISARM_SCRIPT).catch(() => {});
      return { outcome: "cancelled" };
    }
    const answer = await page.executeJavaScript(POLL_SCRIPT).catch(() => null);
    if (answer === "gone") return { outcome: "cancelled" };
    if (typeof answer === "string") {
      const parsed = JSON.parse(answer) as
        | { outcome: "selected"; selection: ServerBrowserElementSelection }
        | { outcome: "cancelled" };
      if (parsed.outcome === "cancelled") return parsed;
      const screenshot = await captureElement(page, parsed.selection.boundingRect).catch(
        () => undefined,
      );
      return { ...parsed, ...(screenshot ? { screenshot } : {}) };
    }
    // The next poll, or sooner when a cancel wakes it.
    const waker = new AbortController();
    onWait(() => waker.abort());
    await delay(POLL_MS, undefined, { signal: waker.signal }).catch(() => {});
  }
}

/** Cancels the tab's pending pick, if any. */
export function cancelPick(page: PickerPage): void {
  active.get(page)?.cancel();
}

export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LayoutViewport {
  pageX: number;
  pageY: number;
  clientWidth: number;
  clientHeight: number;
}

/**
 * The CDP screenshot clip for an element's viewport rect: the part inside the layout viewport,
 * in document coordinates. Null when none of it is visible. The Electron pane captures the same
 * visible region (capturePage of the rect), so a tall element is cut at the viewport edge.
 */
export function elementScreenshotClip(
  rect: PageRect,
  viewport: LayoutViewport,
): (PageRect & { scale: 1 }) | null {
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(viewport.clientWidth, rect.x + rect.width);
  const bottom = Math.min(viewport.clientHeight, rect.y + rect.height);
  if (right - left < 1 || bottom - top < 1) return null;
  return {
    x: left + viewport.pageX,
    y: top + viewport.pageY,
    width: right - left,
    height: bottom - top,
    scale: 1,
  };
}

async function captureElement(
  page: PickerPage,
  rect: PageRect,
): Promise<{ data: string; mimeType: "image/png" } | undefined> {
  if (!page.sendDebugCommand) return undefined;
  const metrics = (await page.sendDebugCommand("Page.getLayoutMetrics")) as {
    cssLayoutViewport: LayoutViewport;
  };
  const clip = elementScreenshotClip(rect, metrics.cssLayoutViewport);
  if (!clip) return undefined;
  const result = (await page.sendDebugCommand("Page.captureScreenshot", {
    format: "png",
    clip,
  })) as { data?: unknown };
  return typeof result.data === "string" ? { data: result.data, mimeType: "image/png" } : undefined;
}
