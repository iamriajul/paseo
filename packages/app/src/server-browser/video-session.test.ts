import type { ServerBrowserVideoChunk } from "@getpaseo/client/internal/daemon-client";
import { describe, expect, it } from "vitest";
import { NativeVideoPort } from "./native-video-port";
import {
  ServerBrowserVideoSession,
  ServerBrowserVideoStream,
  type VideoDecoderPort,
} from "./video-session";

interface FakeChunk extends ServerBrowserVideoChunk {
  acked: boolean;
}

function setup() {
  let now = 0;
  const decoded: number[] = [];
  let resets = 0;
  let keyframeRequests = 0;
  let fatal = 0;
  const port: VideoDecoderPort = {
    decode: (id) => decoded.push(id),
    reset: () => {
      resets += 1;
    },
  };
  const session = new ServerBrowserVideoSession(port, {
    onFatal: () => {
      fatal += 1;
    },
    now: () => now,
  });
  const chunk = (key: boolean): FakeChunk => {
    const made: FakeChunk = {
      key,
      width: 1280,
      height: 800,
      data: new Uint8Array([0, 0, 0, 1, key ? 0x65 : 0x41]),
      acked: false,
      ack: () => {
        made.acked = true;
      },
      requestKeyframe: () => {
        keyframeRequests += 1;
      },
    };
    return made;
  };
  return {
    session,
    chunk,
    decoded,
    advance: (ms: number) => {
      now += ms;
    },
    get resets() {
      return resets;
    },
    get keyframeRequests() {
      return keyframeRequests;
    },
    get fatal() {
      return fatal;
    },
  };
}

describe("ServerBrowserVideoSession", () => {
  it("skips deltas until the first keyframe, acking them and asking for a keyframe", () => {
    const t = setup();
    const early = t.chunk(false);
    t.session.push(early);
    expect(early.acked).toBe(true);
    expect(t.decoded).toEqual([]);
    expect(t.keyframeRequests).toBe(1);
    t.session.push(t.chunk(true));
    t.session.push(t.chunk(false));
    expect(t.decoded).toEqual([0, 1]);
  });

  it("acks each chunk once its frame is on screen, and the ones the decoder skipped before it", () => {
    const t = setup();
    const chunks = [t.chunk(true), t.chunk(false), t.chunk(false)];
    for (const chunk of chunks) t.session.push(chunk);
    expect(chunks.map((c) => c.acked)).toEqual([false, false, false]);
    t.session.frameShown(1);
    expect(chunks.map((c) => c.acked)).toEqual([true, true, false]);
  });

  it("after a decoder error: resets, acks what was pending, waits for a keyframe and asks for one", () => {
    const t = setup();
    const pending = t.chunk(true);
    t.session.push(pending);
    t.session.decoderError();
    expect(pending.acked).toBe(true);
    expect(t.resets).toBe(1);
    expect(t.keyframeRequests).toBe(1);
    t.session.push(t.chunk(false));
    expect(t.decoded).toEqual([0]);
    t.session.push(t.chunk(true));
    expect(t.decoded).toEqual([0, 1]);
  });

  it("rate-limits keyframe requests", () => {
    const t = setup();
    for (let i = 0; i < 10; i++) t.session.push(t.chunk(false));
    expect(t.keyframeRequests).toBe(1);
    t.advance(600);
    t.session.push(t.chunk(false));
    expect(t.keyframeRequests).toBe(2);
  });

  it("gives up on video after three decoder errors in ten seconds, once", () => {
    const t = setup();
    t.session.push(t.chunk(true));
    t.session.decoderError();
    t.advance(11_000);
    t.session.decoderError();
    t.session.decoderError();
    expect(t.fatal).toBe(0);
    t.session.decoderError();
    expect(t.fatal).toBe(1);
    t.session.decoderError();
    const after = t.chunk(true);
    t.session.push(after);
    expect(t.fatal).toBe(1);
    // Nothing more is decoded; the surface is moving to JPEG.
    expect(after.acked).toBe(true);
    expect(t.decoded).toEqual([0]);
  });
});

describe("NativeVideoPort", () => {
  it("reports an error when the native view is gone or the chunk is unusable", () => {
    let errors = 0;
    const port = new NativeVideoPort(
      () => null,
      "ios",
      () => {
        errors += 1;
      },
    );
    port.decode(0, {
      key: true,
      width: 1,
      height: 1,
      data: new Uint8Array([0, 0, 0, 1, 0x65, 0x88]),
      ack: () => {},
      requestKeyframe: () => {},
    });
    expect(errors).toBe(1);
  });

  it("reports an error when the native decode call fails", async () => {
    let errors = 0;
    const calls: Array<{ id: number; key: boolean; sps: number[] | null }> = [];
    const port = new NativeVideoPort(
      () => ({
        decode: async (id, _sample, key, sps) => {
          calls.push({ id, key, sps: sps ? [...sps] : null });
          throw new Error("decoder is gone");
        },
        reset: async () => {},
      }),
      "android",
      () => {
        errors += 1;
      },
    );
    port.decode(4, {
      key: true,
      width: 1,
      height: 1,
      data: new Uint8Array([
        0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 0xce, 0, 0, 0, 1, 0x65, 0x88,
      ]),
      ack: () => {},
      requestKeyframe: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([{ id: 4, key: true, sps: [0x67, 0x42] }]);
    expect(errors).toBe(1);
  });
});

describe("ServerBrowserVideoSession interruptions", () => {
  it("restarts at a keyframe after an interruption without ever giving up on video", () => {
    const t = setup();
    t.session.push(t.chunk(true));
    for (let i = 0; i < 5; i++) {
      t.advance(600);
      t.session.decoderInterrupted();
    }
    expect(t.fatal).toBe(0);
    expect(t.resets).toBe(5);
    expect(t.keyframeRequests).toBe(5);
    t.session.push(t.chunk(false));
    t.session.push(t.chunk(true));
    expect(t.decoded).toEqual([0, 1]);
  });
});

describe("ServerBrowserVideoStream", () => {
  function player() {
    return {
      pushed: 0,
      disposed: 0,
      push() {
        this.pushed += 1;
      },
      dispose() {
        this.disposed += 1;
      },
    };
  }

  it("creates the player at the first chunk and releases it on stop", () => {
    const made: Array<ReturnType<typeof player>> = [];
    const stream = new ServerBrowserVideoStream(() => {
      const next = player();
      made.push(next);
      return next;
    });
    const t = setup();
    stream.push(t.chunk(true));
    stream.push(t.chunk(false));
    stream.stop();
    expect(made.map((p) => [p.pushed, p.disposed])).toEqual([[2, 1]]);
    expect(stream.current).toBeNull();
  });

  it("acks a chunk that arrives once video is off, without bringing a player back", () => {
    let enabled = true;
    const made: Array<ReturnType<typeof player>> = [];
    const stream = new ServerBrowserVideoStream(() => {
      if (!enabled) return null;
      const next = player();
      made.push(next);
      return next;
    });
    const t = setup();
    stream.push(t.chunk(true));
    enabled = false;
    stream.stop();
    const late = t.chunk(false);
    stream.push(late);
    expect(late.acked).toBe(true);
    expect(made).toHaveLength(1);
    expect(stream.current).toBeNull();
  });
});
