import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parentPort } from "node:worker_threads";
import { createJimp } from "@jimp/core";
import bmp from "@jimp/js-bmp";
import gif from "@jimp/js-gif";
import jpeg from "@jimp/js-jpeg";
import png from "@jimp/js-png";
import { methods as resizeMethods } from "@jimp/plugin-resize";
import decodeWebp, { init as initWebpDecoder } from "@jsquash/webp/decode.js";

export interface ThumbnailTask {
  id: number;
  sourcePath: string;
  maxEdge: number;
}

export interface RenderedThumbnail {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

export type ThumbnailReply =
  | { id: number; kind: "result"; value: RenderedThumbnail }
  | { id: number; kind: "error"; message: string };

const Jimp = createJimp({ formats: [png, jpeg, gif, bmp], plugins: [resizeMethods] });
type JimpImage = InstanceType<typeof Jimp>;

let webpReady: Promise<void> | null = null;

// The decoder's own loader fetches its wasm by URL, which Node cannot do for a file.
function loadWebpDecoder(): Promise<void> {
  webpReady ??= (async () => {
    const require = createRequire(import.meta.url);
    const wasm = await readFile(require.resolve("@jsquash/webp/codec/dec/webp_dec.wasm"));
    await initWebpDecoder(await WebAssembly.compile(wasm));
  })();
  return webpReady;
}

async function decode(sourcePath: string): Promise<JimpImage> {
  const bytes = await readFile(sourcePath);
  if (sourcePath.toLowerCase().endsWith(".webp")) {
    await loadWebpDecoder();
    const decoded = await decodeWebp(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    const image = new Jimp({ width: decoded.width, height: decoded.height });
    image.bitmap.data = Buffer.from(decoded.data.buffer, decoded.data.byteOffset);
    return image;
  }
  return (await Jimp.read(bytes)) as JimpImage;
}

function hasTransparency(image: JimpImage): boolean {
  const { data } = image.bitmap;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] < 255) return true;
  }
  return false;
}

export async function renderThumbnail(task: {
  sourcePath: string;
  maxEdge: number;
}): Promise<RenderedThumbnail> {
  const image = await decode(task.sourcePath);
  if (image.bitmap.width > task.maxEdge || image.bitmap.height > task.maxEdge) {
    image.scaleToFit({ w: task.maxEdge, h: task.maxEdge });
  }
  // JPEG has no alpha channel, so a transparent icon would turn black.
  const mimeType = hasTransparency(image) ? "image/png" : "image/jpeg";
  const bytes =
    mimeType === "image/png"
      ? await image.getBuffer("image/png")
      : await image.getBuffer("image/jpeg", { quality: 80 });
  return {
    bytes: new Uint8Array(bytes),
    mimeType,
    width: image.bitmap.width,
    height: image.bitmap.height,
  };
}

const port = parentPort;
port?.on("message", (task: ThumbnailTask) => {
  void renderThumbnail(task).then(
    (value) => port.postMessage({ id: task.id, kind: "result", value } satisfies ThumbnailReply),
    (error: unknown) =>
      port.postMessage({
        id: task.id,
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      } satisfies ThumbnailReply),
  );
});
