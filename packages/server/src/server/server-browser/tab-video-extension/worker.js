// The tab video extension's service worker (see tab-video.ts). The daemon calls these over CDP
// (Runtime.evaluate on this worker); the capture itself runs in the offscreen document.

const OFFSCREEN_URL = "offscreen.html";

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Streams the server browser's tabs to Paseo viewers",
  });
}

async function closeOffscreen() {
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
}

/**
 * A tab capture stream id for the CDP target `targetId`, usable by the offscreen document.
 * chrome.debugger.getTargets maps CDP target ids to tab ids; it attaches to nothing.
 * Capturing without a user gesture works because the daemon starts Chrome with
 * --allowlisted-extension-id for this extension.
 */
async function streamIdFor(targetId) {
  await ensureOffscreen();
  const target = (await chrome.debugger.getTargets()).find((t) => t.id === targetId);
  if (!target || target.tabId === undefined) throw new Error(`No tab for target ${targetId}`);
  // A capture stopped a moment ago may still hold the tab ("Cannot capture a tab with an
  // active stream"); it lets go within a few hundred milliseconds.
  for (let attempt = 0; ; attempt++) {
    try {
      return await chrome.tabCapture.getMediaStreamId({ targetTabId: target.tabId });
    } catch (error) {
      if (attempt >= 20 || !String(error).includes("active stream")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

globalThis.paseoTabVideo = { ensureOffscreen, closeOffscreen, streamIdFor };
