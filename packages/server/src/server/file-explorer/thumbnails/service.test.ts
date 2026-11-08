import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThumbnailRenderer } from "./renderer.js";
import { ExplorerThumbnailService, thumbnailEdgeBucket } from "./service.js";

const Jimp = createJimp({ formats: [png] });
// 640x320 solid WebP, the format agents save screenshots in.
const WEBP_640x320 =
  "UklGRgQCAABXRUJQVlA4IPgBAADwLgCdASqAAkABPpFIoU0lpCMiIAgAsBIJaW7hd1sq7AAABaWych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIfAfpdrxcnIe+2TkPfbJyHvtk5xEXJyHvtk5D32ych77ZOQ9+AIB77ZOQ99snIe+2TkPfbJyP+eTkPfbJyHvtk5D32ych77cy/T2ych77ZOQ99snIe+2TkRA8nIe+2TkPfbJyHvtk5D32zGWntk5D32ych77ZOQ99snIfQvpdrxcnIe+2TkPfbJyHvtlAy8XJyHvtk5D32ych77ZOQ+A/S7Xi5OQ99snIe+2TkPfbJziIuTkPfbJyHvtk5D32ych78AQD32ych77ZOQ99snIe+2Tkf88nIe+2TkPfbJyHvtk5D325l+ntk5D32ych77ZOQ99snIiB5OQ99snIe+2TkPfbJyHvtmMtPbJyHvtk5D32ych77ZOQ+hfS7Xi5OQ99snIe+2TkPfbKBl4uTkPfbJyHvtk5D32ycfwAA/v+UCf//jePgV8l2V//+N8+r7NjH8wdzB3MHcwdzB3MHcwdzB3MHcwdzB3MHcwdzB3MHcwdzB3MHcrxhAE7SIEPSIEPSIEPSIEPSIEPSIEPSIEPSIEPSIEPSIEPSIEPSIEPSIEPSIEPSIEPSIEPSIEPSIAAAAAA=";

async function writePng(filePath: string, size: { width: number; height: number }, alpha = 255) {
  const image = new Jimp({ ...size, color: alpha === 255 ? 0x3366ccff : 0x3366cc00 + alpha });
  writeFileSync(filePath, await image.getBuffer("image/png"));
}

const renderer = new ThumbnailRenderer();
let renders = 0;
const countingRenderer = {
  render(task: { sourcePath: string; maxEdge: number }) {
    renders += 1;
    return renderer.render(task);
  },
};

afterAll(async () => {
  await renderer.close();
});

describe("ExplorerThumbnailService", () => {
  let home: string;
  let shots: string;
  let service: ExplorerThumbnailService;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "thumb-home-"));
    shots = mkdtempSync(path.join(tmpdir(), "thumb-shots-"));
    renders = 0;
    service = new ExplorerThumbnailService({ paseoHome: home, renderer: countingRenderer });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(shots, { recursive: true, force: true });
  });

  it("returns a small JPEG for a large screenshot and caches it on disk", async () => {
    await writePng(path.join(shots, "page.png"), { width: 1440, height: 900 });

    const first = await service.get({ root: shots, relativePath: "page.png", maxEdge: 200 });
    expect(first).toMatchObject({ mimeType: "image/jpeg", width: 256, height: 160 });
    expect(Buffer.from(first.data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    const fresh = new ExplorerThumbnailService({ paseoHome: home, renderer: countingRenderer });
    const second = await fresh.get({ root: shots, relativePath: "page.png", maxEdge: 256 });
    expect(second).toEqual(first);
    expect(renders).toBe(1);
    expect(readdirSync(path.join(home, "cache", "thumbnails"))).toHaveLength(1);
  });

  it("renders again when the image changes", async () => {
    const file = path.join(shots, "page.png");
    await writePng(file, { width: 800, height: 800 });
    await service.get({ root: shots, relativePath: "page.png", maxEdge: 128 });
    await writePng(file, { width: 400, height: 800 });
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);

    const changed = await service.get({ root: shots, relativePath: "page.png", maxEdge: 128 });
    expect(changed).toMatchObject({ width: 64, height: 128 });
    expect(renders).toBe(2);
  });

  it("keeps transparency as PNG and decodes WebP", async () => {
    await writePng(path.join(shots, "icon.png"), { width: 64, height: 64 }, 0x80);
    writeFileSync(path.join(shots, "shot.webp"), Buffer.from(WEBP_640x320, "base64"));

    expect(
      await service.get({ root: shots, relativePath: "icon.png", maxEdge: 128 }),
    ).toMatchObject({ mimeType: "image/png", width: 64, height: 64 });
    expect(
      await service.get({ root: shots, relativePath: "shot.webp", maxEdge: 128 }),
    ).toMatchObject({ mimeType: "image/jpeg", width: 128, height: 64 });
  });

  it("refuses paths that leave the root and files that are not images", async () => {
    mkdirSync(path.join(shots, "inner"));
    await writePng(path.join(shots, "outside.png"), { width: 10, height: 10 });
    writeFileSync(path.join(shots, "inner", "notes.txt"), "hello");

    await expect(
      service.get({
        root: path.join(shots, "inner"),
        relativePath: "../outside.png",
        maxEdge: 128,
      }),
    ).rejects.toThrow("Access outside of workspace is not allowed");
    await expect(
      service.get({ root: path.join(shots, "inner"), relativePath: "notes.txt", maxEdge: 128 }),
    ).rejects.toThrow("No thumbnail for this file type");
    expect(renders).toBe(0);
  });

  it("evicts the least recently used entries beyond the cache budget", async () => {
    const small = new ExplorerThumbnailService({
      paseoHome: home,
      renderer: countingRenderer,
      maxCacheBytes: 1,
    });
    await writePng(path.join(shots, "a.png"), { width: 20, height: 20 });
    await small.get({ root: shots, relativePath: "a.png", maxEdge: 128 });
    await small.evict();
    expect(readdirSync(path.join(home, "cache", "thumbnails"))).toHaveLength(0);
  });

  it("rounds requested sizes up to a cached bucket", () => {
    expect([1, 128, 129, 300, 2000].map(thumbnailEdgeBucket)).toEqual([128, 128, 256, 512, 512]);
  });
});
