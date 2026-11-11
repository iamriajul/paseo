import { describe, expect, it } from "vitest";
import { GalleryImageCache, type GalleryImageTarget, type LoadedGalleryImage } from "./image-cache";

function fakeLoader() {
  const released: string[] = [];
  const pending: { target: GalleryImageTarget; resolve: (version: string) => void }[] = [];
  let made = 0;
  const load = (target: GalleryImageTarget) =>
    new Promise<LoadedGalleryImage>((resolve) => {
      pending.push({
        target,
        resolve: (version) => {
          const url = `blob:${target.path}#${++made}`;
          resolve({
            url,
            version,
            size: { width: 4, height: 3 },
            release: () => released.push(url),
          });
        },
      });
    });
  return { load, pending, released };
}

const target = (path: string): GalleryImageTarget => ({ serverId: "s", cwd: "/repo", path });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("GalleryImageCache", () => {
  it("loads once for every holder and tells subscribers when the image is ready", async () => {
    const loader = fakeLoader();
    const cache = new GalleryImageCache(loader.load);
    let notified = 0;
    cache.subscribe("a", () => notified++);
    cache.retain("a", target("a.png"), null);
    cache.retain("a", target("a.png"), null);
    expect(loader.pending).toHaveLength(1);
    expect(cache.getState("a")).toEqual({ status: "loading" });
    loader.pending[0].resolve("v1");
    await settle();
    expect(notified).toBe(1);
    expect(cache.getState("a")).toEqual({
      status: "ready",
      url: "blob:a.png#1",
      size: { width: 4, height: 3 },
    });
  });

  it("keeps showing the old image while a changed file reloads, then frees the old URL", async () => {
    const loader = fakeLoader();
    const cache = new GalleryImageCache(loader.load);
    cache.retain("a", target("a.png"), null);
    loader.pending[0].resolve("v1");
    await settle();
    cache.retain("a", target("a.png"), "v1");
    expect(loader.pending).toHaveLength(1);
    cache.retain("a", target("a.png"), "v2");
    expect(loader.pending).toHaveLength(2);
    expect(cache.getState("a")).toMatchObject({ url: "blob:a.png#1" });
    loader.pending[1].resolve("v2");
    await settle();
    expect(cache.getState("a")).toMatchObject({ url: "blob:a.png#2" });
    expect(loader.released).toEqual(["blob:a.png#1"]);
  });

  it("frees the least recently used released images past the idle limit, never held ones", async () => {
    const loader = fakeLoader();
    const cache = new GalleryImageCache(loader.load, 1);
    const releaseA = cache.retain("a", target("a.png"), null);
    const releaseB = cache.retain("b", target("b.png"), null);
    cache.retain("c", target("c.png"), null);
    for (const [index, load] of loader.pending.entries()) load.resolve(`v${index}`);
    await settle();
    releaseA();
    expect(loader.released).toEqual([]);
    releaseB();
    expect(loader.released).toEqual(["blob:a.png#1"]);
    expect(cache.getState("a")).toEqual({ status: "loading" });
    expect(cache.getState("c")).toMatchObject({ status: "ready" });
  });

  it("frees a URL that lands after its image was dropped", async () => {
    const loader = fakeLoader();
    const cache = new GalleryImageCache(loader.load, 0);
    const release = cache.retain("a", target("a.png"), null);
    release();
    loader.pending[0].resolve("v1");
    await settle();
    expect(loader.released).toEqual(["blob:a.png#1"]);
  });
});
