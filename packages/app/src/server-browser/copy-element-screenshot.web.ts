import { getDesktopHost } from "@/desktop/host";
import type { ElementScreenshotCopy } from "./copy-element-screenshot";

export type { ElementScreenshotCopy };

/**
 * Copies an element screenshot. Electron copies through the main process, as the desktop Browser
 * pane does; a browser writes the PNG and the element's text as one clipboard item.
 */
export async function copyElementScreenshot(
  copy: ElementScreenshotCopy,
): Promise<"image" | "text"> {
  const imageDataUrl = copy.pngBase64 ? `data:image/png;base64,${copy.pngBase64}` : undefined;
  const bridge = getDesktopHost()?.browser?.copyElement;
  if (typeof bridge === "function") {
    if (!(await bridge({ text: copy.text, imageDataUrl }))) throw new Error("Copy failed");
    return imageDataUrl ? "image" : "text";
  }
  if (imageDataUrl && typeof ClipboardItem !== "undefined") {
    const image = await (await fetch(imageDataUrl)).blob();
    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": image,
        "text/plain": new Blob([copy.text], { type: "text/plain" }),
      }),
    ]);
    return "image";
  }
  await navigator.clipboard.writeText(copy.text);
  return "text";
}
