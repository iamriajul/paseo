import { describe, expect, test } from "vitest";
import { VideoHub, videoWindow, type VideoChunk } from "./video-hub.js";

function chunk(key: boolean): VideoChunk {
  return { key, data: new Uint8Array(key ? 1000 : 100), width: 1280, height: 800 };
}

function setup() {
  let now = 0;
  const keyframeRequests: string[] = [];
  const hub = new VideoHub(
    (encode) => keyframeRequests.push(encode),
    () => now,
  );
  const sent: Record<string, Array<{ seq: number; key: boolean }>> = { a: [], b: [] };
  for (const id of ["a", "b"]) {
    hub.addViewer(id, {
      send: (c, seq) => sent[id]?.push({ seq, key: c.key }),
      isCongested: () => false,
    });
  }
  return {
    hub,
    sent,
    keyframeRequests,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("VideoHub", () => {
  test("a viewer joining an encode gets nothing before a keyframe, and the encode is asked for one", () => {
    const { hub, sent, keyframeRequests } = setup();
    hub.assign("a", "fast");
    expect(keyframeRequests).toEqual(["fast"]);
    hub.publish("fast", chunk(false));
    expect(sent.a).toEqual([]);
    hub.publish("fast", chunk(true));
    hub.publish("fast", chunk(false));
    expect(sent.a).toEqual([
      { seq: 1, key: true },
      { seq: 2, key: false },
    ]);
  });

  test("each viewer gets only its own encode's chunks", () => {
    const { hub, sent } = setup();
    hub.assign("a", "fast");
    hub.assign("b", "slow");
    hub.publish("fast", chunk(true));
    hub.publish("slow", chunk(true));
    hub.publish("slow", chunk(false));
    expect(sent.a).toHaveLength(1);
    expect(sent.b).toHaveLength(2);
  });

  test("a viewer out of credit drops deltas, counts as backlogged, and asks for a keyframe once it has room", () => {
    const { hub, sent, keyframeRequests } = setup();
    hub.assign("a", "fast");
    hub.publish("fast", chunk(true));
    for (let i = 0; i < 20; i++) hub.publish("fast", chunk(false));
    expect(sent.a).toHaveLength(videoWindow(null));
    // One run of drops is a hiccup, not a viewer falling behind.
    expect(hub.backlogged("a")).toBe(false);
    for (const { seq } of sent.a ?? []) hub.ack("a", seq);
    const before = keyframeRequests.length;
    // Nothing is in flight, so no ack is coming: the next delta itself asks for the keyframe.
    hub.publish("fast", chunk(false));
    expect(keyframeRequests.length).toBeGreaterThan(before);
    hub.publish("fast", chunk(true));
    hub.publish("fast", chunk(false));
    expect(sent.a?.slice(-2).map((s) => s.key)).toEqual([true, false]);
    // A second run of drops soon after: now it is falling behind.
    for (let i = 0; i < 20; i++) hub.publish("fast", chunk(false));
    expect(hub.backlogged("a")).toBe(true);
  });

  test("keyframes are never dropped, even past the window", () => {
    const { hub, sent } = setup();
    hub.assign("a", "fast");
    for (let i = 0; i < 20; i++) hub.publish("fast", chunk(true));
    expect(sent.a).toHaveLength(20);
  });

  test("a viewer's keyframe request and a resync make it wait for a keyframe", () => {
    const { hub, sent, keyframeRequests } = setup();
    hub.assign("a", "fast");
    hub.publish("fast", chunk(true));
    hub.keyframe("a");
    expect(keyframeRequests.at(-1)).toBe("fast");
    hub.publish("fast", chunk(false));
    expect(sent.a).toHaveLength(1);
    hub.publish("fast", chunk(true));
    hub.resync();
    hub.publish("fast", chunk(false));
    expect(sent.a).toHaveLength(2);
  });

  test("the window grows with the viewer's round trip", () => {
    const { hub, sent, advance } = setup();
    hub.assign("a", "fast");
    hub.publish("fast", chunk(true));
    advance(400);
    hub.ack("a", 1);
    expect(videoWindow(400)).toBeGreaterThan(videoWindow(null));
    for (let i = 0; i < 30; i++) hub.publish("fast", chunk(false));
    expect(sent.a).toHaveLength(1 + videoWindow(400));
  });
});
