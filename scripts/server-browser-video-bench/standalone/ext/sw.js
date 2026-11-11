async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "stream tabs to Paseo viewers",
  });
}
globalThis.paseoStreamId = async (targetId) => {
  await ensureOffscreen();
  const targets = await chrome.debugger.getTargets();
  const t = targets.find((x) => x.id === targetId);
  if (!t || t.tabId === undefined) throw new Error("no tab for target " + targetId);
  return await chrome.tabCapture.getMediaStreamId({ targetTabId: t.tabId });
};
