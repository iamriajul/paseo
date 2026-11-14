import { planRangeResponse } from "./range";
import { RangeReader, type OpenByteRange } from "./range-reader";

const SCOPE = "/media-stream/";
const WORKER_URL = `${SCOPE}sw.js`;
const FRAME_URL = `${SCOPE}frame.html`;
/** Browsers stop an idle service worker after about 30 s, which would cut a playing stream. */
const KEEPALIVE_MS = 10_000;

export interface MediaStreamSource {
  size: number;
  mimeType: string;
  open: OpenByteRange;
}

export interface PublishedMediaStream {
  /** A document in the worker's scope for the player element. */
  frameUrl: string;
  /** The player element's `src`, valid inside the frame. */
  fileUrl: string;
  release(): void;
}

interface Published extends MediaStreamSource {
  readers: Set<RangeReader>;
}

type WorkerReply = { type: "pull" } | { type: "cancel" };
interface OpenRequest {
  type: "paseo-media-open";
  id: string;
  range: string | null;
}

const published = new Map<string, Published>();
let worker: Promise<ServiceWorkerRegistration> | null = null;
let answering = false;
let keepAlive: ReturnType<typeof setInterval> | null = null;

/** Streaming needs a service worker, which browsers allow only on HTTPS and localhost. */
export function canStreamMedia(): boolean {
  return window.isSecureContext && "serviceWorker" in navigator;
}

/**
 * Serves the source at a URL a player in the returned frame can seek through. The stream lives
 * until `release`, which also stops every read still running.
 */
export async function publishMediaStream(source: MediaStreamSource): Promise<PublishedMediaStream> {
  const registration = await activeWorker();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  published.set(id, { ...source, readers: new Set() });
  keepWorkerAlive(registration);
  return {
    frameUrl: FRAME_URL,
    fileUrl: `${SCOPE}${id}/file`,
    release: () => {
      const stream = published.get(id);
      published.delete(id);
      for (const reader of stream?.readers ?? []) reader.close();
      if (published.size === 0 && keepAlive) {
        clearInterval(keepAlive);
        keepAlive = null;
      }
    },
  };
}

function activeWorker(): Promise<ServiceWorkerRegistration> {
  worker ??= registerWorker().catch((error: unknown) => {
    worker = null;
    throw error;
  });
  return worker;
}

async function registerWorker(): Promise<ServiceWorkerRegistration> {
  if (!answering) {
    answering = true;
    navigator.serviceWorker.addEventListener("message", answerOpen);
    navigator.serviceWorker.startMessages();
  }
  const registration = await navigator.serviceWorker.register(WORKER_URL, { scope: SCOPE });
  const pending = registration.installing ?? registration.waiting;
  if (registration.active && !pending) return registration;
  if (!pending) throw new Error("The media service worker did not install.");
  await new Promise<void>((resolve, reject) => {
    pending.addEventListener("statechange", () => {
      if (pending.state === "activated") resolve();
      if (pending.state === "redundant") reject(new Error("The media service worker failed."));
    });
  });
  return registration;
}

function keepWorkerAlive(registration: ServiceWorkerRegistration): void {
  keepAlive ??= setInterval(() => registration.active?.postMessage({ type: "ping" }), KEEPALIVE_MS);
}

function isOpenRequest(data: unknown): data is OpenRequest {
  return (
    typeof data === "object" &&
    data !== null &&
    Reflect.get(data, "type") === "paseo-media-open" &&
    typeof Reflect.get(data, "id") === "string"
  );
}

/** One player request: the head now, then a chunk per pull until the range is sent. */
function answerOpen(event: MessageEvent): void {
  const port = event.ports[0];
  if (!port || !isOpenRequest(event.data)) return;
  const stream = published.get(event.data.id);
  if (!stream) {
    port.postMessage({ type: "unknown" });
    port.close();
    return;
  }
  const plan = planRangeResponse({
    rangeHeader: event.data.range,
    size: stream.size,
    mimeType: stream.mimeType,
  });
  port.postMessage({
    type: "head",
    status: plan.status,
    headers: plan.headers,
    body: plan.range !== null,
  });
  if (!plan.range) {
    port.close();
    return;
  }
  const reader = new RangeReader(stream.open, plan.range);
  stream.readers.add(reader);
  const finish = () => {
    reader.close();
    stream.readers.delete(reader);
    port.close();
  };
  port.addEventListener("message", (message: MessageEvent<WorkerReply>) => {
    if (message.data.type === "cancel") finish();
    else void sendNext(reader, port, finish);
  });
  port.start();
}

async function sendNext(reader: RangeReader, port: MessagePort, finish: () => void) {
  try {
    const chunk = await reader.next();
    if (!chunk) {
      port.postMessage({ type: "end" });
      finish();
      return;
    }
    const copy = chunk.slice();
    port.postMessage({ type: "chunk", chunk: copy.buffer }, [copy.buffer]);
  } catch (error) {
    port.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    finish();
  }
}
