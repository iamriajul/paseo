import { describe, expect, test } from "vitest";
import type { TabVideoCapture, TabVideoStartParams } from "./tab-video.js";
import { TabVideoStream } from "./tab-video-stream.js";

/** Records the order of calls a TabVideoStream makes on the browser's capture. */
function fakeCapture() {
  const calls: string[] = [];
  const capture = {
    supported: async (codecs: string[]) => codecs,
    start: (params: TabVideoStartParams) => {
      calls.push(`start ${params.id} ${params.width}x${params.height}`);
      return Promise.resolve();
    },
    setEncodes: (id: string) => calls.push(`encodes ${id}`),
    requestKeyframe: () => {},
    stop: (id: string) => calls.push(`stop ${id}`),
  };
  return { calls, capture: capture as unknown as TabVideoCapture };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("TabVideoStream", () => {
  test("a capture that changes size stops the old one before the new one starts", async () => {
    const { calls, capture } = fakeCapture();
    const page = { width: 1280, height: 800, scale: 1 };
    const stream = new TabVideoStream({
      capture: async () => capture,
      targetId: () => "target",
      page: () => page,
      onWatched: () => {},
      onError: () => {},
    });
    stream.addViewer(
      "viewer",
      { send: () => {}, isCongested: () => false, fallback: () => {} },
      { maxWidth: 640, maxHeight: 400, codec: "avc1.42E028" },
    );
    await settle();
    // A larger viewer joins: the capture restarts at its picture while the first keeps watching.
    stream.addViewer(
      "large",
      { send: () => {}, isCongested: () => false, fallback: () => {} },
      { maxWidth: 1280, maxHeight: 800, codec: "avc1.42E028" },
    );
    await settle();
    const firstStart = calls.findIndex((call) => call.startsWith("start"));
    const stop = calls.findIndex((call) => call.startsWith("stop"));
    const secondStart = calls.findLastIndex((call) => call.startsWith("start"));
    expect(firstStart).toBeGreaterThanOrEqual(0);
    expect(secondStart).toBeGreaterThan(firstStart);
    // Chrome refuses a capture of a tab that is still captured.
    expect(stop).toBeGreaterThan(firstStart);
    expect(stop).toBeLessThan(secondStart);
    stream.close();
  });
});
