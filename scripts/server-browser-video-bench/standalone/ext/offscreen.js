// One capture per stream key. Chunks go to the daemon through the CDP binding __paseoVideo.
const streams = new Map();
function send(obj) {
  globalThis.__paseoVideo(JSON.stringify(obj));
}
function b64(buf) {
  let s = "";
  const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i += 0x8000)
    s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
globalThis.paseoStart = async (key, streamId, o) => {
  const media = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxWidth: o.width,
        maxHeight: o.height,
        minWidth: o.width,
        minHeight: o.height,
        maxFrameRate: o.fps,
      },
    },
  });
  const track = media.getVideoTracks()[0];
  const st = { track, frames: 0, wantKey: true, enc: null, cfgW: 0, cfgH: 0 };
  streams.set(key, st);
  const mk = (w, h) => {
    if (st.enc)
      try {
        st.enc.close();
      } catch {}
    st.enc = new VideoEncoder({
      output: (chunk, meta) => {
        const b = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(b);
        send({
          k: key,
          t: chunk.type,
          ts: chunk.timestamp,
          w,
          h,
          d: b64(b),
          cfg: meta?.decoderConfig ? { codec: meta.decoderConfig.codec } : undefined,
        });
      },
      error: (e) => send({ k: key, err: String(e) }),
    });
    st.enc.configure({
      codec: o.codec,
      width: w,
      height: h,
      bitrate: o.bitrate,
      framerate: o.fps,
      latencyMode: "realtime",
      hardwareAcceleration: "prefer-software",
      ...(o.codec.startsWith("avc1") ? { avc: { format: "annexb" } } : {}),
      bitrateMode: o.bitrateMode || "variable",
    });
    st.cfgW = w;
    st.cfgH = h;
  };
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  (async () => {
    for (;;) {
      const { value: f, done } = await reader.read();
      if (done) break;
      const w = f.codedWidth & ~1,
        h = f.codedHeight & ~1;
      if (w !== st.cfgW || h !== st.cfgH) {
        mk(w, h);
        st.wantKey = true;
      }
      if (st.enc.encodeQueueSize > 2) {
        f.close();
        continue;
      } // drop, never queue
      st.enc.encode(f, { keyFrame: st.wantKey || st.frames % (o.gop || 600) === 0 });
      st.wantKey = false;
      st.frames++;
      f.close();
    }
  })();
  return { settings: track.getSettings() };
};
globalThis.paseoKey = (key) => {
  const s = streams.get(key);
  if (s) s.wantKey = true;
};
globalThis.paseoStop = (key) => {
  const s = streams.get(key);
  if (s) {
    s.track.stop();
    try {
      s.enc?.close();
    } catch {}
    streams.delete(key);
  }
};
