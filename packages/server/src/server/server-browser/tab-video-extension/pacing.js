/*
 * Adapted from ace (https://github.com/arpan404/ace), packages/browser/src/video-pacing.ts at
 * commit 939e3d1fd66bbed2373dcaf65aa873a0d2ed62b6.
 * Copyright 2026 Arpan Bhandari. Licensed under the Apache License, Version 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0).
 * Changes for Paseo: plain JavaScript in a classic script, exposed as globalThis.paseoPacing.
 *
 * When an encoder encodes a captured frame, and whether as a keyframe. Pure, with the time
 * passed in: the offscreen document runs it per frame, and tab-video-pacing.test.ts drives it.
 */
(() => {
  /** A keyframe at least this often, so a viewer that lost its place is never stuck for long. */
  const keyframePeriodMs = 6_000;
  /** Forced keyframes (a viewer joined or dropped deltas) at most this often per encode. */
  const keyframeGapMs = 500;
  /** A still page sends no frames: an owed keyframe re-encodes the last one after this long. */
  const stillFrameMs = 100;
  /** An encoder with frames in and nothing out for this long is stuck. */
  const stallMs = 1_500;

  class EncodePacer {
    constructor(fps) {
      this.fps = fps;
      this.nextAt = -Infinity;
      this.lastKey = -Infinity;
      this.owed = true;
    }
    /** A keyframe is owed; it goes with the next frame the gap allows. */
    requestKeyframe() {
      this.owed = true;
    }
    /** A captured frame arrived; `busy` is the encoder still working through earlier frames. */
    frame(now, busy) {
      if (busy) return "skip";
      if (this.keyDue(now)) return this.encoded(now, true);
      // Frames arrive on the display's clock with some jitter: one up to half a 60 Hz frame
      // before its slot still takes it, so 30 fps out of 60 Hz doesn't fall to every third frame.
      if (now < this.nextAt - 8) return "skip";
      return this.encoded(now, false);
    }
    /** No frame came for a while: whether to encode the last one again as an owed keyframe. */
    still(now, lastFrameAt, busy) {
      if (busy || now - lastFrameAt < stillFrameMs || !this.keyDue(now)) return false;
      this.encoded(now, true);
      return true;
    }
    keyDue(now) {
      if (now - this.lastKey >= keyframePeriodMs) return true;
      return this.owed && now - this.lastKey >= keyframeGapMs;
    }
    encoded(now, key) {
      const interval = 1000 / this.fps;
      // The next slot follows this one's; after a pause it starts again from now, not in a burst.
      this.nextAt = Math.max(this.nextAt + interval, now + interval - 8);
      if (!key) return "delta";
      this.lastKey = now;
      this.owed = false;
      return "key";
    }
  }

  /**
   * Tells a working encoder from one that takes frames and never answers (a hardware encoder
   * that accepted its config and then produced nothing, as branded Chrome 155 did headless).
   */
  class EncoderWatchdog {
    constructor() {
      this.waitingSince = undefined;
    }
    submitted(now) {
      this.waitingSince ??= now;
    }
    output() {
      this.waitingSince = undefined;
    }
    stalled(now) {
      return this.waitingSince !== undefined && now - this.waitingSince >= stallMs;
    }
  }

  globalThis.paseoPacing = { EncodePacer, EncoderWatchdog, keyframePeriodMs, keyframeGapMs };
})();
