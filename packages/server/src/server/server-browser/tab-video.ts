import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { CdpConnection, CdpEvent } from "./cdp-connection.js";

/**
 * Real video of a tab. The extension in `tab-video-extension/` captures the tab with
 * `chrome.tabCapture`, its offscreen document encodes the frames with WebCodecs, and every
 * chunk comes back through a CDP binding. Only a Chrome the daemon launched can run it: loading an
 * unpacked extension needs `--enable-unsafe-extension-debugging` with CDP over a pipe, and
 * capturing without a user gesture needs the extension allowlisted. chrome-headless-shell has no
 * Extensions domain and no tab capture, and an Existing browser was started without the flags, so
 * both stay on JPEG. See docs/server-browser.md.
 */

/** Pinned by the manifest's `key`; --allowlisted-extension-id names it. */
export const TAB_VIDEO_EXTENSION_ID = "gmmiejlmbkolphieepcebimkcgdedgom";

export const TAB_VIDEO_CHROME_ARGS = [
  "--enable-unsafe-extension-debugging",
  `--allowlisted-extension-id=${TAB_VIDEO_EXTENSION_ID}`,
];

const BINDING = "__paseoTabVideo";
/** The offscreen document (about 80 MB while capturing) closes this long after its last capture. */
const OFFSCREEN_IDLE_MS = 30_000;
const EXTENSION_SOURCE = fileURLToPath(new URL("./tab-video-extension/", import.meta.url));

export interface TabVideoEncodeSpec {
  /** Stable while the encode's settings are: a new key is a new encoder. */
  key: string;
  codec: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}

export interface TabVideoCaptureListener {
  onChunk(encode: string, chunk: { key: boolean; data: Buffer }): void;
  /** No encoder configuration works for this encode. */
  onEncodeFailed(encode: string, reason: string): void;
  /** The capture stopped by itself (the tab closed, Chrome ended the track). */
  onEnded(reason: string): void;
}

export interface TabVideoStartParams {
  id: string;
  targetId: string;
  width: number;
  height: number;
  fps: number;
  listener: TabVideoCaptureListener;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

interface ExtensionEvent {
  t: "chunk" | "failed" | "ended";
  capture: string;
  encode?: string;
  key?: boolean;
  reason?: string;
}

/** The browser's tab-capture extension; one per launched Chrome, shared by every tab. */
export class TabVideoCapture {
  private readonly listeners = new Map<string, TabVideoCaptureListener>();
  private offscreen: Promise<string> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly supportedCache = new Map<string, Promise<string[]>>();
  /** Offscreen calls run one at a time, so closing the document never races a start. */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly connection: CdpConnection,
    private readonly workerSession: string,
  ) {
    connection.on("event", (event) => this.onEvent(event));
  }

  /** Copies the extension to `directory` (Chrome cannot read it from inside an asar) and loads it. */
  public static async load(connection: CdpConnection, directory: string): Promise<TabVideoCapture> {
    await cp(EXTENSION_SOURCE, directory, { recursive: true, force: true });
    const { id } = (await connection.send("Extensions.loadUnpacked", { path: directory })) as {
      id?: string;
    };
    if (id !== TAB_VIDEO_EXTENSION_ID) {
      throw new Error(`The tab video extension loaded as ${String(id)}`);
    }
    const origin = `chrome-extension://${id}/`;
    const worker = await waitForTarget(
      connection,
      (target) => target.type === "service_worker" && target.url.startsWith(origin),
    );
    const workerSession = await attach(connection, worker.targetId);
    await connection.send("Runtime.runIfWaitingForDebugger", {}, workerSession).catch(() => {});
    await waitForGlobal(connection, workerSession, "paseoTabVideo");
    return new TabVideoCapture(connection, workerSession);
  }

  /** The codecs of `codecs` this Chrome encodes, in the order asked. */
  public supported(codecs: string[]): Promise<string[]> {
    const cacheKey = codecs.join(",");
    let cached = this.supportedCache.get(cacheKey);
    if (!cached) {
      cached = this.run(async (session) => {
        const value = await evaluate(
          this.connection,
          session,
          `paseoVideo.supported(${JSON.stringify(codecs)}, 1280, 800)`,
        );
        return Array.isArray(value)
          ? value.filter((codec): codec is string => typeof codec === "string")
          : [];
      });
      cached.catch(() => this.supportedCache.delete(cacheKey));
      this.supportedCache.set(cacheKey, cached);
    }
    return cached;
  }

  /** Opens (or reopens at a new size) capture `id` of the tab `targetId`. */
  public start(params: TabVideoStartParams): Promise<void> {
    this.listeners.set(params.id, params.listener);
    const started = this.run(async (session) => {
      const streamId = await evaluate(
        this.connection,
        this.workerSession,
        `paseoTabVideo.streamIdFor(${JSON.stringify(params.targetId)})`,
      );
      await evaluate(
        this.connection,
        session,
        `paseoVideo.start(${JSON.stringify(params.id)}, ${JSON.stringify(streamId)}, ${params.width}, ${params.height}, ${params.fps})`,
      );
    });
    started.catch(() => {
      if (this.listeners.get(params.id) === params.listener) this.listeners.delete(params.id);
    });
    return started;
  }

  /** The encodes capture `id` runs; new ones start at a keyframe, missing ones stop. */
  public setEncodes(id: string, specs: TabVideoEncodeSpec[]): void {
    this.call(`paseoVideo.encodes(${JSON.stringify(id)}, ${JSON.stringify(specs)})`);
  }

  public requestKeyframe(id: string, encode: string): void {
    this.call(`paseoVideo.keyframe(${JSON.stringify(id)}, ${JSON.stringify(encode)})`);
  }

  public stop(id: string): void {
    if (!this.listeners.delete(id)) return;
    this.call(`paseoVideo.stop(${JSON.stringify(id)})`);
    if (this.listeners.size === 0) this.scheduleIdleClose();
  }

  /** Whether the offscreen document is open (or opening). */
  public get hasOffscreen(): boolean {
    return this.offscreen !== null;
  }

  private call(expression: string): void {
    void this.run((session) => evaluate(this.connection, session, expression)).catch(() => {});
  }

  private run<T>(action: (offscreenSession: string) => Promise<T>): Promise<T> {
    this.cancelIdleClose();
    const result = this.queue.then(async () => action(await this.ensureOffscreen()));
    this.queue = result.catch(() => {});
    return result;
  }

  private ensureOffscreen(): Promise<string> {
    if (!this.offscreen) {
      const opening = this.openOffscreen();
      opening.catch(() => {
        if (this.offscreen === opening) this.offscreen = null;
      });
      this.offscreen = opening;
    }
    return this.offscreen;
  }

  private async openOffscreen(): Promise<string> {
    await evaluate(this.connection, this.workerSession, "paseoTabVideo.ensureOffscreen()");
    const target = await waitForTarget(
      this.connection,
      (info) => info.url === `chrome-extension://${TAB_VIDEO_EXTENSION_ID}/offscreen.html`,
    );
    const session = await attach(this.connection, target.targetId);
    await this.connection.send("Runtime.addBinding", { name: BINDING }, session);
    await waitForGlobal(this.connection, session, "paseoVideo");
    return session;
  }

  private scheduleIdleClose(): void {
    this.cancelIdleClose();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.listeners.size > 0 || !this.offscreen) return;
      this.offscreen = null;
      this.queue = this.queue
        .then(() => evaluate(this.connection, this.workerSession, "paseoTabVideo.closeOffscreen()"))
        .catch(() => {});
    }, OFFSCREEN_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private cancelIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private onEvent(event: CdpEvent): void {
    if (event.method !== "Runtime.bindingCalled") return;
    if (event.params.name !== BINDING || typeof event.params.payload !== "string") return;
    const payload = event.params.payload;
    const newline = payload.indexOf("\n");
    const message = JSON.parse(newline < 0 ? payload : payload.slice(0, newline)) as ExtensionEvent;
    const listener = this.listeners.get(message.capture);
    if (!listener) return;
    switch (message.t) {
      case "chunk":
        listener.onChunk(message.encode ?? "", {
          key: message.key === true,
          data: Buffer.from(newline < 0 ? "" : payload.slice(newline + 1), "base64"),
        });
        return;
      case "failed":
        listener.onEncodeFailed(message.encode ?? "", message.reason ?? "encode failed");
        return;
      case "ended":
        this.listeners.delete(message.capture);
        listener.onEnded(message.reason ?? "The tab capture ended");
        return;
    }
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
  throw new Error("The tab video extension's page did not appear");
}

async function attach(connection: CdpConnection, targetId: string): Promise<string> {
  const { sessionId } = (await connection.send("Target.attachToTarget", {
    targetId,
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

/** A just-started worker or document may not have run its script yet. */
async function waitForGlobal(
  connection: CdpConnection,
  sessionId: string,
  name: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(connection, sessionId, `typeof globalThis.${name} === "object"`)) return;
    await delay(50);
  }
  throw new Error(`The tab video extension never defined ${name}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
