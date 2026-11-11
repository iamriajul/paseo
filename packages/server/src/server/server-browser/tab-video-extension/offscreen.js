/*
 * Adapted from ace (https://github.com/arpan404/ace), packages/browser/video-extension/offscreen.ts
 * at commit 939e3d1fd66bbed2373dcaf65aa873a0d2ed62b6.
 * Copyright 2026 Arpan Bhandari. Licensed under the Apache License, Version 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0).
 * Changes for Paseo: plain JavaScript; H.264 in Annex B (SPS/PPS in band, no description); the
 * capture frame rate comes from the daemon; the CDP binding and global names are Paseo's; an
 * encoder the watchdog stops with no configuration left retries the last one (on a loaded host
 * software H.264 can stall for seconds, and failing would send its viewers to JPEG for good).
 *
 * The tab video extension's offscreen document: opens a tab capture and encodes it with
 * WebCodecs, once per encode the daemon asks for. The daemon drives it over CDP
 * (Runtime.evaluate on this document) and receives every event through the CDP binding
 * `__paseoTabVideo`: a JSON line, then for a chunk its bytes in base64.
 */
(() => {
  const { EncodePacer, EncoderWatchdog } = globalThis.paseoPacing;
  const captures = new Map();
  const now = () => performance.now();

  function emit(event, bytes) {
    const send = globalThis.__paseoTabVideo;
    if (typeof send !== "function") return;
    const line = JSON.stringify(event);
    send(bytes ? `${line}\n${base64(bytes)}` : line);
  }

  function base64(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }

  function configsFor(spec) {
    const base = {
      codec: spec.codec,
      width: spec.width,
      height: spec.height,
      bitrate: spec.bitrate,
      framerate: spec.fps,
      latencyMode: "realtime",
      bitrateMode: "variable",
      ...(spec.codec.startsWith("avc1.") ? { avc: { format: "annexb" } } : {}),
    };
    return [
      { ...base, hardwareAcceleration: "prefer-hardware" },
      { ...base, hardwareAcceleration: "prefer-software" },
    ];
  }

  /** The next configuration this encode can run with; none left reports it failed. */
  async function configure(capture, entry, reason, stalled = false) {
    if (stalled && entry.configs.length === 0 && entry.lastConfig) {
      entry.configs.push(entry.lastConfig);
    }
    if (entry.encoder && entry.encoder.state !== "closed") entry.encoder.close();
    entry.encoder = undefined;
    const generation = ++entry.generation;
    for (let config = entry.configs.shift(); config; config = entry.configs.shift()) {
      const support = await VideoEncoder.isConfigSupported(config).catch(() => undefined);
      if (generation !== entry.generation || capture.encoders.get(entry.spec.key) !== entry) {
        return;
      }
      if (!support?.supported) continue;
      const encoder = new VideoEncoder({
        output: (chunk) => {
          if (generation !== entry.generation) return;
          entry.watchdog.output();
          const bytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(bytes);
          emit(
            { t: "chunk", capture: capture.id, encode: entry.spec.key, key: chunk.type === "key" },
            bytes,
          );
        },
        error: (error) => {
          if (generation !== entry.generation) return;
          void configure(capture, entry, String(error));
        },
      });
      encoder.configure(config);
      entry.encoder = encoder;
      entry.lastConfig = config;
      entry.watchdog = new EncoderWatchdog();
      entry.pacer.requestKeyframe();
      return;
    }
    emit({ t: "failed", capture: capture.id, encode: entry.spec.key, reason });
  }

  function encode(entry, frame, key) {
    const encoder = entry.encoder;
    if (!encoder || encoder.state !== "configured") return;
    // Our own clock: a still frame encoded again needs a later timestamp than last time.
    const stamped = new VideoFrame(frame, { timestamp: Math.round(now() * 1000) });
    try {
      encoder.encode(stamped, { keyFrame: key });
      entry.watchdog.submitted(now());
    } finally {
      stamped.close();
    }
  }

  const busy = (entry) => (entry.encoder?.encodeQueueSize ?? 0) > 2;

  async function pump(capture) {
    for (;;) {
      const { done, value } = await capture.reader.read();
      if (done || !value) break;
      if (capture.stopped) {
        value.close();
        break;
      }
      capture.last?.close();
      capture.last = value;
      capture.lastAt = now();
      for (const entry of capture.encoders.values()) {
        const decision = entry.pacer.frame(capture.lastAt, busy(entry));
        if (decision !== "skip") encode(entry, value, decision === "key");
      }
    }
    if (!capture.stopped) {
      stop(capture.id);
      emit({ t: "ended", capture: capture.id });
    }
  }

  function closeEntry(entry) {
    entry.generation++;
    if (entry.encoder && entry.encoder.state !== "closed") entry.encoder.close();
  }

  function stop(id) {
    const capture = captures.get(id);
    if (!capture) return;
    captures.delete(id);
    capture.stopped = true;
    for (const entry of capture.encoders.values()) closeEntry(entry);
    capture.encoders.clear();
    void capture.reader.cancel().catch(() => {});
    capture.track.stop();
    capture.last?.close();
    capture.last = undefined;
  }

  // Owed keyframes on a still page, and encoders that stopped answering.
  setInterval(() => {
    const at = now();
    for (const capture of captures.values()) {
      for (const entry of capture.encoders.values()) {
        if (entry.watchdog.stalled(at)) {
          void configure(capture, entry, "The encoder stopped producing output", true);
          continue;
        }
        if (capture.last && entry.pacer.still(at, capture.lastAt, busy(entry))) {
          encode(entry, capture.last, true);
        }
      }
    }
  }, 50);

  globalThis.paseoVideo = {
    /** The codecs this browser encodes at this size, in the order asked. */
    async supported(codecs, width, height) {
      const supported = [];
      for (const codec of codecs) {
        const configs = configsFor({ key: "", codec, width, height, fps: 30, bitrate: 2e6 });
        for (const config of configs) {
          const result = await VideoEncoder.isConfigSupported(config).catch(() => undefined);
          if (result?.supported) {
            supported.push(codec);
            break;
          }
        }
      }
      return supported;
    },
    /** Opens the tab capture `streamId` at exactly this size, replacing capture `id`. */
    async start(id, streamId, width, height, fps) {
      stop(id);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId,
            minWidth: width,
            maxWidth: width,
            minHeight: height,
            maxHeight: height,
            maxFrameRate: fps,
          },
        },
      });
      const [track] = stream.getVideoTracks();
      if (!track) throw new Error("No tab capture");
      const capture = {
        id,
        track,
        reader: new MediaStreamTrackProcessor({ track }).readable.getReader(),
        last: undefined,
        lastAt: 0,
        encoders: new Map(),
        stopped: false,
      };
      captures.set(id, capture);
      void pump(capture).catch((error) => {
        if (capture.stopped) return;
        stop(id);
        emit({ t: "ended", capture: id, reason: String(error) });
      });
    },
    /** The encodes capture `id` runs: new ones start (at a keyframe), missing ones stop. */
    encodes(id, specs) {
      const capture = captures.get(id);
      if (!capture) return;
      const wanted = new Set(specs.map((spec) => spec.key));
      for (const [key, entry] of capture.encoders) {
        if (!wanted.has(key)) {
          closeEntry(entry);
          capture.encoders.delete(key);
        }
      }
      for (const spec of specs) {
        if (capture.encoders.has(spec.key)) continue;
        const entry = {
          spec,
          encoder: undefined,
          pacer: new EncodePacer(spec.fps),
          watchdog: new EncoderWatchdog(),
          configs: configsFor(spec),
          lastConfig: undefined,
          generation: 0,
        };
        capture.encoders.set(spec.key, entry);
        void configure(capture, entry, "No encoder supports this codec here");
      }
    },
    keyframe(id, key) {
      captures.get(id)?.encoders.get(key)?.pacer.requestKeyframe();
    },
    stop,
    /** How many captures are open; the daemon closes this document when none are. */
    count: () => captures.size,
  };
})();
