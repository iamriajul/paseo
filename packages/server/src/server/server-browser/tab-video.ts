import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CdpConnection, CdpEvent } from "./cdp-connection.js";

/**
 * Real video of a tab: an extension the daemon loads over CDP captures the tab
 * (`chrome.tabCapture`), its offscreen document encodes it with WebCodecs, and every chunk comes
 * back through a CDP binding. Only a Chrome the daemon launched can do it: loading an unpacked
 * extension needs `--enable-unsafe-extension-debugging` with CDP over a pipe, and capturing a tab
 * without a user gesture needs the extension allowlisted. chrome-headless-shell has neither the
 * Extensions domain nor tab capture. See docs/server-browser-video-research.md.
 */

// The manifest key pins the extension id, which --allowlisted-extension-id names.
const EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtJr0rPEVFF5FeUauphhFG1TZULRNhbpFHxtChDpYfCeQ8tcL0T0SpTn2KgVmPz6frTijcm6L0kaajVZqkab/S8czdT/zLqdwfz9u1BCeS8yrnHdkgJe2Jkc4y5vqWX7h8mXnqdyP9ZWHNHGZcpmF7Cueuf26O6axeR8bEL96HmxmMmfvPdZzmabS+f4cSI5ZYtFRzYHvlPWkEAQLQQPWd9McLAsdWrxD8jirDzBw6Ih2jDGoCzon7mPo2dkNr5z3SY03yGObdDN6ZOfNBiYoEhVo/cSsjTfhgsPGAqoyvus5wa2FWasTBRduIhdrfg7MYZC3JXWr976KbtJteaMshQIDAQAB";
export const TAB_VIDEO_EXTENSION_ID = "gmmiejlmbkolphieepcebimkcgdedgom";

export const TAB_VIDEO_CHROME_ARGS = [
  "--enable-unsafe-extension-debugging",
  `--allowlisted-extension-id=${TAB_VIDEO_EXTENSION_ID}`,
];

const BINDING = "__paseoTabVideo";

const MANIFEST = {
  manifest_version: 3,
  name: "Paseo tab video",
  version: "0.1",
  key: EXTENSION_KEY,
  // debugger: only for chrome.debugger.getTargets, which maps a CDP target id to a tab id. It never attaches.
  permissions: ["tabCapture", "offscreen", "debugger"],
  background: { service_worker: "sw.js" },
};

const SERVICE_WORKER = `
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["USER_MEDIA"], justification: "stream tabs to Paseo viewers" });
}
globalThis.paseoEnsureOffscreen = ensureOffscreen;
globalThis.paseoStreamId = async (targetId) => {
  await ensureOffscreen();
  const target = (await chrome.debugger.getTargets()).find((t) => t.id === targetId);
  if (!target || target.tabId === undefined) throw new Error("no tab for target " + targetId);
  return await chrome.tabCapture.getMediaStreamId({ targetTabId: target.tabId });
};
`;

const OFFSCREEN = `
const streams = new Map();
const send = (message) => globalThis.${BINDING}(JSON.stringify(message));
function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
globalThis.paseoPickCodec = async (codecs, width, height) => {
  for (const codec of codecs) {
    const config = { codec, width, height, bitrate: 4e6, framerate: 60, latencyMode: "realtime", hardwareAcceleration: "prefer-software" };
    try { if ((await VideoEncoder.isConfigSupported(config)).supported) return codec; } catch {}
  }
  return null;
};
globalThis.paseoStart = async (key, streamId, options) => {
  globalThis.paseoStop(key);
  const media = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
    chromeMediaSource: "tab", chromeMediaSourceId: streamId,
    maxWidth: options.width, maxHeight: options.height, minWidth: options.width, minHeight: options.height,
    maxFrameRate: options.fps } } });
  const track = media.getVideoTracks()[0];
  const stream = { track, encoder: null, width: 0, height: 0, wantKey: true, frames: 0 };
  streams.set(key, stream);
  const configure = (width, height) => {
    try { stream.encoder?.close(); } catch {}
    stream.encoder = new VideoEncoder({
      output: (chunk) => {
        const data = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(data);
        send({ key, type: chunk.type, width, height, data: base64(data) });
      },
      error: (error) => send({ key, error: String(error) }),
    });
    stream.encoder.configure({
      codec: options.codec, width, height, framerate: options.fps, latencyMode: "realtime",
      bitrate: Math.round(Math.max(1e6, Math.min(8e6, width * height * 4))),
      hardwareAcceleration: "prefer-software",
      ...(options.codec.startsWith("avc1") ? { avc: { format: "annexb" } } : {}),
    });
    stream.width = width;
    stream.height = height;
    stream.wantKey = true;
  };
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  (async () => {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) return;
      if (streams.get(key) !== stream) { frame.close(); return; }
      const width = frame.codedWidth & ~1, height = frame.codedHeight & ~1;
      if (width !== stream.width || height !== stream.height) configure(width, height);
      // A busy encoder drops the frame instead of queueing it: latency over completeness.
      if (stream.encoder.encodeQueueSize > 2) { frame.close(); continue; }
      const keyFrame = stream.wantKey || stream.frames % (options.fps * 10) === 0;
      stream.wantKey = false;
      stream.encoder.encode(frame, { keyFrame });
      stream.frames += 1;
      frame.close();
    }
  })().catch((error) => send({ key, error: String(error) }));
  track.addEventListener("ended", () => send({ key, error: "capture ended" }));
};
globalThis.paseoKeyframe = (key) => { const stream = streams.get(key); if (stream) stream.wantKey = true; };
globalThis.paseoStop = (key) => {
  const stream = streams.get(key);
  if (!stream) return;
  streams.delete(key);
  stream.track.stop();
  try { stream.encoder?.close(); } catch {}
};
`;

export interface TabVideoChunk {
  key: boolean;
  data: Buffer;
  codedWidth: number;
  codedHeight: number;
}

export interface TabVideoStreamOptions {
  targetId: string;
  width: number;
  height: number;
  codec: string;
  fps: number;
}

export interface TabVideoListener {
  onChunk(chunk: TabVideoChunk): void;
  onError(message: string): void;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

/** The browser's tab-capture extension; one per launched Chrome, shared by every tab. */
export class TabVideoCapture {
  private readonly listeners = new Map<string, TabVideoListener>();
  private nextKey = 1;

  private constructor(
    private readonly connection: CdpConnection,
    private readonly workerSession: string,
    private readonly offscreenSession: string,
  ) {
    connection.on("event", (event) => this.onEvent(event));
  }

  public static async load(connection: CdpConnection, directory: string): Promise<TabVideoCapture> {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "manifest.json"), JSON.stringify(MANIFEST));
    await writeFile(join(directory, "sw.js"), SERVICE_WORKER);
    await writeFile(
      join(directory, "offscreen.html"),
      '<!doctype html><script src="offscreen.js"></script>',
    );
    await writeFile(join(directory, "offscreen.js"), OFFSCREEN);
    const { id } = (await connection.send("Extensions.loadUnpacked", { path: directory })) as {
      id?: string;
    };
    if (id !== TAB_VIDEO_EXTENSION_ID) {
      throw new Error(`tab video extension loaded as ${String(id)}`);
    }
    const origin = `chrome-extension://${id}/`;
    const worker = await waitForTarget(
      connection,
      (target) => target.type === "service_worker" && target.url.startsWith(origin),
    );
    const workerSession = await attach(connection, worker);
    await connection.send("Runtime.runIfWaitingForDebugger", {}, workerSession).catch(() => {});
    await evaluateWhenDefined(
      connection,
      workerSession,
      "paseoEnsureOffscreen",
      "paseoEnsureOffscreen()",
    );
    const offscreen = await waitForTarget(
      connection,
      (target) => target.url === `${origin}offscreen.html`,
    );
    const offscreenSession = await attach(connection, offscreen);
    await connection.send("Runtime.addBinding", { name: BINDING }, offscreenSession);
    return new TabVideoCapture(connection, workerSession, offscreenSession);
  }

  /** The first codec of `codecs` this Chrome encodes, or null. */
  public async pickCodec(codecs: string[], width: number, height: number): Promise<string | null> {
    const picked = await evaluate(
      this.connection,
      this.offscreenSession,
      `paseoPickCodec(${JSON.stringify(codecs)}, ${width}, ${height})`,
    );
    return typeof picked === "string" ? picked : null;
  }

  /** Starts capturing a tab; returns the stream's key. */
  public async start(options: TabVideoStreamOptions, listener: TabVideoListener): Promise<string> {
    const key = `s${this.nextKey++}`;
    const streamId = await evaluateWhenDefined(
      this.connection,
      this.workerSession,
      "paseoStreamId",
      `paseoStreamId(${JSON.stringify(options.targetId)})`,
    );
    this.listeners.set(key, listener);
    try {
      await evaluate(
        this.connection,
        this.offscreenSession,
        `paseoStart(${JSON.stringify(key)}, ${JSON.stringify(streamId)}, ${JSON.stringify(options)})`,
      );
    } catch (error) {
      this.listeners.delete(key);
      throw error;
    }
    return key;
  }

  public requestKeyframe(key: string): void {
    void evaluate(
      this.connection,
      this.offscreenSession,
      `paseoKeyframe(${JSON.stringify(key)})`,
    ).catch(() => {});
  }

  public stop(key: string): void {
    this.listeners.delete(key);
    void evaluate(
      this.connection,
      this.offscreenSession,
      `paseoStop(${JSON.stringify(key)})`,
    ).catch(() => {});
  }

  private onEvent(event: CdpEvent): void {
    if (event.method !== "Runtime.bindingCalled" || event.sessionId !== this.offscreenSession) {
      return;
    }
    if (event.params.name !== BINDING || typeof event.params.payload !== "string") return;
    const message = JSON.parse(event.params.payload) as {
      key: string;
      type?: string;
      width?: number;
      height?: number;
      data?: string;
      error?: string;
    };
    const listener = this.listeners.get(message.key);
    if (!listener) return;
    if (message.error) {
      listener.onError(message.error);
      return;
    }
    listener.onChunk({
      key: message.type === "key",
      data: Buffer.from(message.data ?? "", "base64"),
      codedWidth: message.width ?? 0,
      codedHeight: message.height ?? 0,
    });
  }
}

async function waitForTarget(
  connection: CdpConnection,
  match: (target: TargetInfo) => boolean,
): Promise<TargetInfo> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { targetInfos } = (await connection.send("Target.getTargets")) as {
      targetInfos: TargetInfo[];
    };
    const found = targetInfos.find(match);
    if (found) return found;
    await delay(50);
  }
  throw new Error("tab video extension target did not appear");
}

async function attach(connection: CdpConnection, target: TargetInfo): Promise<string> {
  const { sessionId } = (await connection.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  })) as { sessionId: string };
  return sessionId;
}

async function evaluate(
  connection: CdpConnection,
  sessionId: string,
  expression: string,
): Promise<unknown> {
  const result = (await connection.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  )) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "evaluate failed",
    );
  }
  return result.result?.value;
}

/** A just-started service worker may not have run its script yet. */
async function evaluateWhenDefined(
  connection: CdpConnection,
  sessionId: string,
  name: string,
  expression: string,
): Promise<unknown> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await evaluate(connection, sessionId, `typeof ${name} === "function"`)) {
      return evaluate(connection, sessionId, expression);
    }
    await delay(50);
  }
  throw new Error(`${name} never became available`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
