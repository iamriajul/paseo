import { i18n } from "@/i18n/i18next";
import { triggerBrowserDownload } from "@/downloads/save-file";
import { DownloadCancelledError } from "@/downloads/download-cancelled-error";
import type {
  DownloadDestination,
  DownloadSink,
  DownloadTarget,
  PrepareDownloadDestination,
} from "@/downloads/download-destination.types";

export type {
  DownloadDestination,
  DownloadSink,
  DownloadTarget,
  PrepareDownloadDestination,
} from "@/downloads/download-destination.types";

/**
 * Browsers stream a download to disk three ways, tried in order:
 *
 * 1. File System Access (`showSaveFilePicker`): Chrome and Edge on desktop, and Electron, whose
 *    `paseo://` scheme cannot host a service worker. Chrome writes to a swap file and moves it
 *    into place on close, so an aborted download leaves nothing behind.
 * 2. A service worker scoped to /download-stream/ answers a hidden iframe's navigation with a
 *    streamed attachment, so the browser's own download manager writes the file: Chrome on
 *    Android, Firefox and Safari. It needs a secure context (HTTPS or localhost). The browser
 *    pulls from the stream as it writes, and each pull asks for one slice.
 * 3. Otherwise (plain HTTP on a LAN address without File System Access) the bytes collect in a
 *    Blob, capped at BLOB_FALLBACK_MAX_BYTES.
 */
export const prepareDownloadDestination: PrepareDownloadDestination = async (suggestedName) => {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (picker) {
    // Called before the first await: the prompt needs the tap's user activation.
    const picked = picker.call(window, { suggestedName });
    let handle: FileSystemFileHandleLike;
    try {
      handle = await picked;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null;
      throw error;
    }
    return filePickerDestination(handle);
  }
  return {
    begin: async (target) => (await openServiceWorkerSink(target)) ?? openBlobSink(target),
    discard: async () => undefined,
  };
};

// The File System Access types are not in TypeScript's DOM lib yet.
interface WritableFileStreamLike {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
interface FileSystemFileHandleLike {
  createWritable(): Promise<WritableFileStreamLike>;
  remove?: () => Promise<void>;
}
interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandleLike>;
}

function filePickerDestination(handle: FileSystemFileHandleLike): DownloadDestination {
  // Chrome creates the chosen file, empty, as soon as the prompt closes.
  const removeFile = async () => {
    await handle.remove?.().catch(() => undefined);
  };
  return {
    discard: removeFile,
    begin: async () => {
      const writable = await handle.createWritable();
      return {
        write: (chunk) => writable.write(chunk),
        close: async () => {
          await writable.close();
          return null;
        },
        abort: async (reason) => {
          await writable.abort(reason).catch(() => undefined);
          await removeFile();
        },
      };
    },
  };
}

const SERVICE_WORKER_SCOPE = "/download-stream/";
const SERVICE_WORKER_URL = `${SERVICE_WORKER_SCOPE}sw.js`;
/** Browsers stop an idle service worker after about 30 s; a ping keeps it serving the stream. */
const SERVICE_WORKER_KEEPALIVE_MS = 10_000;
/** The browser asks for the first bytes once it has started the download. */
const SERVICE_WORKER_START_TIMEOUT_MS = 15_000;

type ServiceWorkerReply = { type: "registered" } | { type: "pull" } | { type: "cancel" };

async function activeDownloadWorker(): Promise<ServiceWorker | null> {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
      scope: SERVICE_WORKER_SCOPE,
    });
    if (registration.active) return registration.active;
    const pending = registration.installing ?? registration.waiting;
    if (!pending) return null;
    return await new Promise<ServiceWorker | null>((resolve) => {
      pending.addEventListener("statechange", () => {
        if (pending.state === "activated") resolve(pending);
        if (pending.state === "redundant") resolve(null);
      });
    });
  } catch (error) {
    console.warn("[Downloads] Streaming service worker unavailable:", error);
    return null;
  }
}

async function openServiceWorkerSink(target: DownloadTarget): Promise<DownloadSink | null> {
  const worker = await activeDownloadWorker();
  if (!worker) return null;
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const channel = new MessageChannel();
  const port = channel.port1;
  let pull: { resolve: () => void; reject: (error: Error) => void } | null = null;
  let pulls = 0;
  let cancelled = false;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The download service worker did not answer.")),
      SERVICE_WORKER_START_TIMEOUT_MS,
    );
    port.addEventListener("message", (event: MessageEvent<ServiceWorkerReply>) => {
      const reply = event.data;
      if (reply.type === "registered") {
        clearTimeout(timer);
        resolve();
      } else if (reply.type === "pull") {
        pulls += 1;
        const waiter = pull;
        pull = null;
        waiter?.resolve();
      } else if (reply.type === "cancel") {
        cancelled = true;
        pull?.reject(new DownloadCancelledError());
        pull = null;
      }
    });
    port.start();
    worker.postMessage(
      {
        type: "register",
        id,
        fileName: target.fileName,
        mimeType: target.mimeType,
        size: target.size,
      },
      [channel.port2],
    );
  });

  const keepAlive = setInterval(
    () => worker.postMessage({ type: "ping" }, []),
    SERVICE_WORKER_KEEPALIVE_MS,
  );
  const iframe = document.createElement("iframe");
  iframe.hidden = true;
  iframe.src = `${SERVICE_WORKER_SCOPE}${id}/${encodeURIComponent(target.fileName)}`;
  document.body.appendChild(iframe);

  let consumed = 0;
  async function nextPull(timeoutMs: number | null): Promise<void> {
    if (cancelled) throw new DownloadCancelledError();
    if (pulls > consumed) {
      consumed += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(
              () => reject(new Error("The browser did not start the download.")),
              timeoutMs,
            );
      pull = {
        resolve: () => {
          if (timer) clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      };
    });
    consumed += 1;
  }
  function finish() {
    clearInterval(keepAlive);
    // The download manager owns the response now; the iframe can go once it has the last byte.
    setTimeout(() => iframe.remove(), 1_000);
  }

  return {
    write: async (chunk) => {
      await nextPull(consumed === 0 ? SERVICE_WORKER_START_TIMEOUT_MS : null);
      const copy = chunk.slice();
      port.postMessage({ type: "chunk", chunk: copy.buffer }, [copy.buffer]);
    },
    close: async () => {
      await nextPull(consumed === 0 ? SERVICE_WORKER_START_TIMEOUT_MS : null);
      port.postMessage({ type: "end" });
      finish();
      return null;
    },
    abort: async (reason) => {
      // Erroring the stream makes the browser mark the download failed and drop the partial file.
      port.postMessage({ type: "error", message: reason.message });
      finish();
    },
  };
}

/** Plain-HTTP browsers without File System Access can only build the file in memory. */
const BLOB_FALLBACK_MAX_BYTES = 64 * 1024 * 1024;

function openBlobSink(target: DownloadTarget): DownloadSink {
  const parts: Blob[] = [];
  let size = 0;
  const tooLarge = () =>
    new Error(i18n.t("downloads.browserMemoryLimit", { fileName: target.fileName, size: "64 MB" }));
  if (target.size !== null && target.size > BLOB_FALLBACK_MAX_BYTES) {
    throw tooLarge();
  }
  return {
    write: async (chunk) => {
      size += chunk.byteLength;
      if (size > BLOB_FALLBACK_MAX_BYTES) throw tooLarge();
      // A small Blob per slice lets the browser drop the slice's ArrayBuffer.
      parts.push(new Blob([chunk.slice()]));
    },
    close: async () => {
      const url = URL.createObjectURL(new Blob(parts, { type: target.mimeType }));
      triggerBrowserDownload(url, target.fileName);
      // The browser may still be reading the blob while its save prompt is open.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return null;
    },
    abort: async () => {
      parts.length = 0;
    },
  };
}
