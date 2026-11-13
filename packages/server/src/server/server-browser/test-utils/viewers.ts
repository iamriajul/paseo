import type { ServerBrowserHost } from "../server-browser-host.js";

/** Resolves with the first JPEG frame a screencast viewer of the tab receives. */
export function firstFrame(host: ServerBrowserHost, browserId: string) {
  const tab = host.getTab(browserId)!;
  return new Promise<{ width: number; jpeg: Uint8Array }>((resolve) => {
    tab.screencast.addViewer(
      "test",
      {
        send: (frame) => resolve(frame),
        isCongested: () => false,
      },
      { maxWidth: 640, maxHeight: 400 },
    );
  });
}

export interface VideoWatch {
  chunks: Array<{ key: boolean; bytes: number; at: number }>;
  fellBack: boolean;
  stop(): void;
}

/**
 * Watches a tab as a video viewer that acks every chunk at once; null when the tab offers no
 * codec in common (an engine without tab capture).
 */
export async function watchVideo(host: ServerBrowserHost, browserId: string, codecs: string[]) {
  const tab = host.getTab(browserId)!;
  const codec = await tab.video?.negotiate(codecs);
  if (!codec || !tab.video) return null;
  const video = tab.video;
  const watch: VideoWatch = {
    chunks: [],
    fellBack: false,
    stop: () => video.removeViewer("test"),
  };
  video.addViewer(
    "test",
    {
      send: (chunk, seq) => {
        watch.chunks.push({ key: chunk.key, bytes: chunk.data.byteLength, at: Date.now() });
        video.hub.ack("test", seq);
      },
      isCongested: () => false,
      fallback: () => {
        watch.fellBack = true;
      },
    },
    { maxWidth: 1280, maxHeight: 800, codec },
  );
  return { codec, watch };
}

export async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
