// Plays media files read over the session socket, with seeking. A media element's requests reach
// a service worker only from a document the worker controls, so the player lives in frame.html,
// inside this worker's /media-stream/ scope; the app's own pages and requests never pass through
// it. For each request to /media-stream/<id>/file the worker asks the app's windows which one
// published <id>; that page answers the Range header with a status, headers and a body it pulls
// from the daemon one chunk at a time, and only as fast as the player reads. The worker keeps no
// state, so a restarted worker still serves the next request.

const OPEN_TIMEOUT_MS = 15_000;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const match = /^\/media-stream\/([^/]+)\/file$/.exec(url.pathname);
  if (!match) return;
  event.respondWith(respond(match[1], event.request.headers.get("range")));
});

/** Asks every app window for the stream; resolves with the one that published it. */
async function openStream(id, range) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const pages = windows.filter(
    (client) => !new URL(client.url).pathname.startsWith("/media-stream/"),
  );
  return new Promise((resolve, reject) => {
    let unanswered = pages.length;
    if (unanswered === 0) {
      reject(new Error("No Paseo window is open."));
      return;
    }
    const timer = setTimeout(() => reject(new Error("No window answered.")), OPEN_TIMEOUT_MS);
    for (const page of pages) {
      const { port1: port, port2 } = new MessageChannel();
      const answer = (event) => {
        port.removeEventListener("message", answer);
        if (event.data.type === "head") {
          clearTimeout(timer);
          resolve({ port, head: event.data });
          return;
        }
        port.close();
        unanswered -= 1;
        if (unanswered === 0) {
          clearTimeout(timer);
          reject(new Error("The media stream is closed."));
        }
      };
      port.addEventListener("message", answer);
      port.start();
      page.postMessage({ type: "paseo-media-open", id, range }, [port2]);
    }
  });
}

async function respond(id, range) {
  let opened;
  try {
    opened = await openStream(id, range);
  } catch (error) {
    return new Response(error.message, { status: 404 });
  }
  const { port, head } = opened;
  if (!head.body) {
    port.close();
    return new Response(null, { status: head.status, headers: head.headers });
  }
  let output = null;
  let waiting = null;
  port.addEventListener("message", (event) => {
    const reply = event.data;
    const settle = waiting;
    waiting = null;
    if (reply.type === "chunk") output?.enqueue(new Uint8Array(reply.chunk));
    else if (reply.type === "end") output?.close();
    else if (reply.type === "error") output?.error(new Error(reply.message || "Read failed"));
    settle?.();
  });
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
        // The player moved on (a seek, or the tab closed): the page closes the daemon read.
        port.postMessage({ type: "cancel" });
        port.close();
      },
    },
    { highWaterMark: 1 },
  );
  return new Response(body, { status: head.status, headers: head.headers });
}
