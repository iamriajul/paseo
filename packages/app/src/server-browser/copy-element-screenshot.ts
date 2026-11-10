import * as Clipboard from "expo-clipboard";

export interface ElementScreenshotCopy {
  /** Base64 PNG of the element's visible part, when the daemon could crop it. */
  pngBase64: string | undefined;
  /** The element as the Browsers format it, for a clipboard that takes no image. */
  text: string;
}

/** Copies an element screenshot as the Android Browser pane does; text when there is no crop. */
export async function copyElementScreenshot(
  copy: ElementScreenshotCopy,
): Promise<"image" | "text"> {
  if (copy.pngBase64) {
    await Clipboard.setImageAsync(copy.pngBase64);
    return "image";
  }
  await Clipboard.setStringAsync(copy.text);
  return "text";
}
