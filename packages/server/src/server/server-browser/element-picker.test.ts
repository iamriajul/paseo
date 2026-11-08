import pino from "pino";
import { describe, expect, it } from "vitest";
import type { SessionOutboundMessage } from "../messages.js";
import { SessionDelivery } from "../session/owned-subscriptions/index.js";
import { elementScreenshotClip, type PickerPage } from "./element-picker.js";
import type { ServerBrowserHost } from "./server-browser-host.js";
import { ServerBrowserSessionHandlers } from "./session-handlers.js";

const VIEWPORT = { pageX: 0, pageY: 600, clientWidth: 1280, clientHeight: 800 };

describe("elementScreenshotClip", () => {
  it("moves the viewport rect into document coordinates", () => {
    expect(elementScreenshotClip({ x: 100, y: 100, width: 200, height: 50 }, VIEWPORT)).toEqual({
      x: 100,
      y: 700,
      width: 200,
      height: 50,
      scale: 1,
    });
  });

  it("keeps only the part inside the viewport", () => {
    expect(elementScreenshotClip({ x: -50, y: 700, width: 2000, height: 400 }, VIEWPORT)).toEqual({
      x: 0,
      y: 1300,
      width: 1280,
      height: 100,
      scale: 1,
    });
  });

  it("has nothing to crop for an element scrolled out of view", () => {
    expect(elementScreenshotClip({ x: 0, y: 900, width: 100, height: 100 }, VIEWPORT)).toBeNull();
    expect(elementScreenshotClip({ x: 0, y: 0, width: 0, height: 10 }, VIEWPORT)).toBeNull();
  });
});

const SELECTION = {
  tag: "div",
  text: "Save draft",
  selector: "#target",
  url: "http://localhost:3000/",
  outerHTML: '<div id="target">Save draft</div>',
  computedStyles: { display: "block" },
  boundingRect: { x: 10, y: 20, width: 30, height: 40 },
  reactSource: {
    fileName: "/src/SaveButton.tsx",
    lineNumber: 12,
    columnNumber: 7,
    componentName: "SaveButton",
  },
  parentChain: ["body", "html"],
  children: [],
};

/**
 * A page that answers the picker's scripts the way the armed selector does: nothing until
 * `answer` is set, then the answer once. Records CDP commands so the crop request is visible.
 */
function scriptedPage() {
  const page = {
    answer: null as string | null,
    armed: false,
    commands: [] as Array<{ method: string; params?: Record<string, unknown> }>,
    executeJavaScript: async (code: string): Promise<unknown> => {
      if (code.includes("start-select")) page.armed = true;
      else if (code.includes("__paseoSelector.destroy")) page.armed = false;
      else if (code.includes("handle.take()")) {
        const answer = page.answer;
        page.answer = null;
        return answer;
      }
      return true;
    },
    sendDebugCommand: async (method: string, params?: Record<string, unknown>) => {
      page.commands.push({ method, params });
      if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: VIEWPORT };
      return { data: "iVBORw0KGgo=" };
    },
  };
  return page satisfies PickerPage;
}

function harness() {
  const page = scriptedPage();
  const tab = { contents: page, touch: () => {} };
  const host = { getTab: (id: string) => (id === "tab-1" ? tab : null) };
  const emitted: SessionOutboundMessage[] = [];
  const delivery = new SessionDelivery(() => {});
  const handlers = new ServerBrowserSessionHandlers({
    host: host as unknown as ServerBrowserHost,
    delivery,
    emit: (message) => emitted.push(message),
    logger: pino({ level: "silent" }),
    sessionId: "session-1",
  });
  const socket = {};
  delivery.attach(socket, true);
  const send = (message: Parameters<ServerBrowserSessionHandlers["handle"]>[0]) =>
    delivery.request(socket, message, () => handlers.handle(message));
  return { page, emitted, delivery, socket, send };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(condition()).toBe(true);
}

describe("browser.server.tab.annotate RPCs", () => {
  it("answers start with the selection and the element's crop once the user picks", async () => {
    const { page, emitted, send } = harness();
    const pending = send({
      type: "browser.server.tab.annotate.start.request",
      requestId: "r1",
      browserId: "tab-1",
    });
    await until(() => page.armed);
    expect(emitted).toEqual([]);

    page.answer = JSON.stringify({ outcome: "selected", selection: SELECTION });
    await pending;

    expect(emitted).toEqual([
      {
        type: "browser.server.tab.annotate.start.response",
        payload: {
          requestId: "r1",
          outcome: "selected",
          selection: SELECTION,
          screenshot: { data: "iVBORw0KGgo=", mimeType: "image/png" },
        },
      },
    ]);
    expect(page.commands.at(-1)).toEqual({
      method: "Page.captureScreenshot",
      params: { format: "png", clip: { x: 10, y: 620, width: 30, height: 40, scale: 1 } },
    });
  });

  it("answers start with cancelled after a cancel request, and disarms the page", async () => {
    const { page, emitted, send } = harness();
    const pending = send({
      type: "browser.server.tab.annotate.start.request",
      requestId: "r1",
      browserId: "tab-1",
    });
    await until(() => page.armed);
    await send({
      type: "browser.server.tab.annotate.cancel.request",
      requestId: "r2",
      browserId: "tab-1",
    });
    await pending;
    expect(emitted).toEqual([
      { type: "browser.server.tab.annotate.cancel.response", payload: { requestId: "r2" } },
      {
        type: "browser.server.tab.annotate.start.response",
        payload: { requestId: "r1", outcome: "cancelled" },
      },
    ]);
    expect(page.armed).toBe(false);
  });

  it("disarms the page when the requesting client disconnects", async () => {
    const { page, delivery, socket, send } = harness();
    const pending = send({
      type: "browser.server.tab.annotate.start.request",
      requestId: "r1",
      browserId: "tab-1",
    });
    await until(() => page.armed);
    await delivery.detach(socket);
    await pending;
    expect(page.armed).toBe(false);
  });

  it("reports an unknown tab", async () => {
    const { emitted, send } = harness();
    await send({
      type: "browser.server.tab.annotate.start.request",
      requestId: "r1",
      browserId: "nope",
    });
    expect(emitted).toEqual([
      {
        type: "browser.server.tab.annotate.start.response",
        payload: { requestId: "r1", error: "No server browser tab nope" },
      },
    ]);
  });
});
