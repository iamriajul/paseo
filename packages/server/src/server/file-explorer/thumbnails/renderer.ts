import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import pLimit from "p-limit";
import type { RenderedThumbnail, ThumbnailReply, ThumbnailTask } from "./worker.js";

const IDLE_TIMEOUT_MS = 10_000;
const source = import.meta.url.endsWith(".ts");
const workerUrl = new URL(source ? "./worker.ts" : "./worker.js", import.meta.url);
// Same development loader as the plugin compiler: packaged workers run plain JavaScript.
const workerEntrypoint = source
  ? `import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)}).then(({ register }) => { register(); return import(${JSON.stringify(workerUrl.href)}); });`
  : workerUrl;

/**
 * Decodes and resizes images on a worker thread. The decoders are pure JavaScript and a large
 * screenshot takes a few hundred milliseconds, which on the daemon's own thread would stall
 * every terminal and agent stream. One image at a time; the worker exits when idle.
 */
export class ThumbnailRenderer {
  private readonly queue = pLimit(1);
  private worker: Worker | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 0;

  render(task: { sourcePath: string; maxEdge: number }): Promise<RenderedThumbnail> {
    return this.queue(async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      const worker = this.worker ?? this.startWorker();
      try {
        return await this.request(worker, { id: ++this.nextId, ...task });
      } finally {
        if (this.worker === worker) {
          this.idleTimer = setTimeout(() => this.stopWorker(worker), IDLE_TIMEOUT_MS);
          this.idleTimer.unref();
        }
      }
    });
  }

  async close(): Promise<void> {
    if (this.worker) {
      const worker = this.worker;
      this.stopWorker(worker);
      await worker.terminate();
    }
  }

  private startWorker(): Worker {
    const worker = new Worker(workerEntrypoint, { eval: source, execArgv: [] });
    worker.unref();
    this.worker = worker;
    worker.on("error", () => this.stopWorker(worker));
    worker.on("exit", () => this.stopWorker(worker));
    return worker;
  }

  private stopWorker(worker: Worker): void {
    if (this.worker !== worker) return;
    this.worker = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    void worker.terminate();
  }

  private request(worker: Worker, task: ThumbnailTask): Promise<RenderedThumbnail> {
    return new Promise<RenderedThumbnail>((resolve, reject) => {
      const cleanup = () => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };
      const onMessage = (reply: ThumbnailReply) => {
        if (reply.id !== task.id) return;
        cleanup();
        if (reply.kind === "result") resolve(reply.value);
        else reject(new Error(reply.message));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number) => {
        cleanup();
        reject(new Error(`Thumbnail worker exited (code ${code})`));
      };
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      worker.postMessage(task, []);
    });
  }
}
