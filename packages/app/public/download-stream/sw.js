// Streams downloads read over the session socket to the browser's download manager.
// The page registers a download and a MessagePort, then points a hidden iframe at
// /download-stream/<id>/<name>. This worker answers that navigation with a ReadableStream
// whose every pull asks the page for one more slice, so the browser writes the file to disk
// as it arrives and the page holds only the slice in flight. Scoped to /download-stream/:
// the app's own pages and requests never pass through it.

const pending = new Map();

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "register" || !event.ports[0]) return; // "ping" only keeps us alive
  const port = event.ports[0];
  pending.set(data.id, {
    port,
    fileName: data.fileName,
    mimeType: data.mimeType,
    size: data.size,
  });
  port.postMessage({ type: "registered" });
});

function contentDisposition(fileName) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const match = /^\/download-stream\/([^/]+)\//.exec(url.pathname);
  if (!match) return;
  const download = pending.get(match[1]);
  if (!download) return;
  pending.delete(match[1]);
  const { port } = download;
  let waiting = null;
  let output = null;
  port.addEventListener("message", (message) => {
    const reply = message.data;
    const settle = waiting;
    waiting = null;
    // The page can fail the download between pulls; error the stream either way.
    if (reply.type === "error") output?.error(new Error(reply.message || "Download failed"));
    else if (reply.type === "chunk") output?.enqueue(new Uint8Array(reply.chunk));
    else if (reply.type === "end") output?.close();
    settle?.();
  });
  port.start();
  const body = new ReadableStream(
    {
      start(controller) {
        output = controller;
      },
      pull() {
        return new Promise((resolve) => {
          waiting = resolve;
          port.postMessage({ type: "pull" });
        });
      },
      cancel() {
        port.postMessage({ type: "cancel" });
      },
    },
    { highWaterMark: 1 },
  );
  const headers = {
    "Content-Type": download.mimeType || "application/octet-stream",
    "Content-Disposition": contentDisposition(download.fileName),
    "X-Content-Type-Options": "nosniff",
  };
  if (typeof download.size === "number") headers["Content-Length"] = String(download.size);
  event.respondWith(new Response(body, { headers }));
});
