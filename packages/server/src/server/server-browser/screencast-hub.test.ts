import { describe, expect, it } from "vitest";
import {
  SCREENCAST_CREDIT_WINDOW,
  ScreencastHub,
  screencastWindow,
  type ScreencastFrame,
  type ScreencastSize,
} from "./screencast-hub.js";

function frame(label: number): ScreencastFrame {
  return { jpeg: new Uint8Array([label]), width: 1280, height: 800 };
}

function createSource() {
  const calls: Array<{ kind: "start"; size: ScreencastSize } | { kind: "stop" }> = [];
  return {
    calls,
    start: (size: ScreencastSize) => calls.push({ kind: "start", size }),
    stop: () => calls.push({ kind: "stop" }),
  };
}

function createViewer() {
  const received: Array<{ label: number; seq: number }> = [];
  let congested = false;
  return {
    received,
    setCongested: (value: boolean) => {
      congested = value;
    },
    sink: {
      send: (sent: ScreencastFrame, seq: number) => received.push({ label: sent.jpeg[0]!, seq }),
      isCongested: () => congested,
    },
  };
}

function createAckCounter() {
  let acked = 0;
  return {
    ack: () => acked++,
    get count() {
      return acked;
    },
  };
}

const SIZE = { maxWidth: 800, maxHeight: 600 };

describe("ScreencastHub", () => {
  it("runs the source only while someone watches, at the largest requested size", () => {
    const source = createSource();
    const hub = new ScreencastHub(source);
    hub.addViewer("phone", createViewer().sink, { maxWidth: 400, maxHeight: 800 });
    hub.addViewer("desktop", createViewer().sink, { maxWidth: 1400, maxHeight: 900 });
    hub.removeViewer("phone");
    hub.removeViewer("desktop");

    expect(source.calls).toEqual([
      { kind: "start", size: { maxWidth: 400, maxHeight: 800 } },
      { kind: "start", size: { maxWidth: 1400, maxHeight: 900 } },
      { kind: "stop" },
    ]);
  });

  it("caps the stream size at 1600 device pixels", () => {
    const source = createSource();
    new ScreencastHub(source).addViewer("v", createViewer().sink, {
      maxWidth: 5000,
      maxHeight: 3000,
    });
    expect(source.calls[0]).toEqual({ kind: "start", size: { maxWidth: 1600, maxHeight: 1600 } });
  });

  it("holds Chromium's ack once every viewer is out of credit, and releases it on a viewer ack", () => {
    const hub = new ScreencastHub(createSource());
    const viewer = createViewer();
    const chromium = createAckCounter();
    hub.addViewer("v", viewer.sink, SIZE);

    for (let label = 1; label <= SCREENCAST_CREDIT_WINDOW; label++) {
      hub.pushFrame(frame(label), chromium.ack);
    }
    expect(viewer.received.map((r) => r.label)).toEqual([1, 2]);
    // The second frame spent the last credit, so Chromium is not told to send more.
    expect(chromium.count).toBe(1);

    hub.ack("v", 1);
    expect(chromium.count).toBe(2);
  });

  it("gives a saturated viewer only the newest frame when it catches up", () => {
    const hub = new ScreencastHub(createSource());
    const viewer = createViewer();
    hub.addViewer("v", viewer.sink, SIZE);
    hub.pushFrame(frame(1), () => {});
    hub.pushFrame(frame(2), () => {});
    hub.pushFrame(frame(3), () => {});
    hub.pushFrame(frame(4), () => {});

    hub.ack("v", 1);

    expect(viewer.received.map((r) => r.label)).toEqual([1, 2, 4]);
    expect(viewer.received.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("keeps feeding a fast viewer while a slow one is saturated", () => {
    const hub = new ScreencastHub(createSource());
    const slow = createViewer();
    const fast = createViewer();
    const chromium = createAckCounter();
    hub.addViewer("slow", slow.sink, SIZE);
    hub.addViewer("fast", fast.sink, SIZE);

    for (let label = 1; label <= 5; label++) {
      hub.pushFrame(frame(label), chromium.ack);
      const last = fast.received.at(-1);
      if (last) hub.ack("fast", last.seq);
    }

    expect(fast.received.map((r) => r.label)).toEqual([1, 2, 3, 4, 5]);
    expect(slow.received.map((r) => r.label)).toEqual([1, 2]);
    expect(chromium.count).toBe(5);
  });

  it("does not send to a congested socket and delivers the newest frame once it drains", () => {
    const hub = new ScreencastHub(createSource());
    const viewer = createViewer();
    hub.addViewer("v", viewer.sink, SIZE);
    hub.pushFrame(frame(1), () => {});
    viewer.setCongested(true);
    hub.pushFrame(frame(2), () => {});
    hub.pushFrame(frame(3), () => {});
    expect(viewer.received.map((r) => r.label)).toEqual([1]);

    viewer.setCongested(false);
    hub.ack("v", 1);
    expect(viewer.received.map((r) => r.label)).toEqual([1, 3]);
  });

  it("widens the window for a viewer on a long round trip, up to 8 frames", () => {
    let clock = 0;
    const hub = new ScreencastHub(createSource(), () => clock);
    const viewer = createViewer();
    hub.addViewer("relayed", viewer.sink, SIZE);
    hub.pushFrame(frame(1), () => {});
    clock += 400;
    hub.ack("relayed", 1);
    for (let label = 2; label <= 20; label++) hub.pushFrame(frame(label), () => {});

    // 400 ms at 15 fps is 7 frames in flight: frames 2-8 once frame 1 measured the round trip.
    expect(viewer.received.map((r) => r.label)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(screencastWindow(400)).toBe(7);
    expect(screencastWindow(2000)).toBe(8);
    expect(screencastWindow(5)).toBe(2);
  });

  it("shows a late joiner the current picture without waiting for a repaint", () => {
    const hub = new ScreencastHub(createSource());
    hub.addViewer("first", createViewer().sink, SIZE);
    hub.pushFrame(frame(7), () => {});
    const late = createViewer();
    hub.addViewer("late", late.sink, SIZE);
    expect(late.received.map((r) => r.label)).toEqual([7]);
  });

  it("ignores acks for frames a viewer never received", () => {
    const hub = new ScreencastHub(createSource());
    const viewer = createViewer();
    const chromium = createAckCounter();
    hub.addViewer("v", viewer.sink, SIZE);
    hub.pushFrame(frame(1), chromium.ack);
    hub.pushFrame(frame(2), chromium.ack);
    hub.ack("v", 99);
    expect(chromium.count).toBe(1);
  });

  it("releases a held Chromium ack when the last saturated viewer leaves", () => {
    const hub = new ScreencastHub(createSource());
    const chromium = createAckCounter();
    hub.addViewer("v", createViewer().sink, SIZE);
    hub.pushFrame(frame(1), chromium.ack);
    hub.pushFrame(frame(2), chromium.ack);
    hub.removeViewer("v");
    expect(chromium.count).toBe(2);
  });
});
