import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { VideoHub, videoWindow, type VideoChunk } from "./video-hub.js";

function chunk(key: boolean): VideoChunk {
  return { key, data: new Uint8Array(key ? 1000 : 100), width: 1280, height: 800 };
}

function setup() {
  let now = 0;
  const keyframeRequests: number[] = [];
  const hub = new VideoHub(
    { start: () => {}, stop: () => {}, requestKeyframe: () => keyframeRequests.push(now) },
    () => now,
  );
  const sent: Array<{ seq: number; key: boolean }> = [];
  hub.addViewer(
    "v",
    { send: (c, seq) => sent.push({ seq, key: c.key }), isCongested: () => false },
    { maxWidth: 1280, maxHeight: 800 },
  );
  return {
    hub,
    sent,
    keyframeRequests,
    advance: (ms: number) => {
      now += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

describe("VideoHub", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("a viewer that joins gets no delta before a keyframe, and a keyframe is asked for", () => {
    const { hub, sent, keyframeRequests } = setup();
    expect(keyframeRequests).toHaveLength(1);
    hub.pushChunk(chunk(false));
    expect(sent).toEqual([]);
    hub.pushChunk(chunk(true));
    hub.pushChunk(chunk(false));
    expect(sent).toEqual([
      { seq: 1, key: true },
      { seq: 2, key: false },
    ]);
  });

  test("a viewer out of credit drops deltas, then asks for a keyframe once it has room again", () => {
    const { hub, sent, keyframeRequests, advance } = setup();
    hub.pushChunk(chunk(true));
    for (let i = 0; i < 20; i++) hub.pushChunk(chunk(false));
    // The window (no RTT yet) holds VIDEO_MIN_WINDOW chunks; the rest were dropped.
    expect(sent).toHaveLength(videoWindow(null));
    for (const { seq } of sent) hub.ack("v", seq);
    advance(1000);
    const before = keyframeRequests.length;
    // Nothing is in flight, so no ack is coming: the next delta itself must trigger the request.
    hub.pushChunk(chunk(false));
    advance(1000);
    expect(keyframeRequests.length).toBeGreaterThan(before);
    hub.pushChunk(chunk(true));
    hub.pushChunk(chunk(false));
    expect(sent.slice(-2).map((s) => s.key)).toEqual([true, false]);
  });

  test("a keyframe request inside the rate limit is deferred, not lost", () => {
    const { hub, keyframeRequests, advance } = setup();
    expect(keyframeRequests).toEqual([0]);
    hub.resetStream();
    expect(keyframeRequests).toEqual([0]);
    advance(600);
    expect(keyframeRequests).toHaveLength(2);
  });
});
