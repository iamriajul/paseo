import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../../atomic-file.js";
import { resolveExplorerFilePath } from "../service.js";
import type { ThumbnailRenderer } from "./renderer.js";

/** Requested sizes round up to one of these, so a grid size change mostly hits the cache. */
export const THUMBNAIL_EDGE_BUCKETS = [128, 256, 512] as const;
export const THUMBNAIL_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".webp",
]);
/** Larger sources are not decoded: the cost would land on the daemon host for one grid tile. */
export const MAX_THUMBNAIL_SOURCE_BYTES = 40 * 1024 * 1024;
const DEFAULT_MAX_CACHE_BYTES = 128 * 1024 * 1024;
/** Eviction rescans the directory only every this many writes. */
const EVICTION_INTERVAL_WRITES = 32;

const CachedThumbnailSchema = z.object({
  mimeType: z.string(),
  width: z.number(),
  height: z.number(),
  data: z.string(),
});
export type ExplorerThumbnail = z.infer<typeof CachedThumbnailSchema>;

export function thumbnailEdgeBucket(maxEdge: number): number {
  return THUMBNAIL_EDGE_BUCKETS.find((edge) => edge >= maxEdge) ?? THUMBNAIL_EDGE_BUCKETS.at(-1)!;
}

export class ExplorerThumbnailService {
  private readonly directory: string;
  private readonly renderer: Pick<ThumbnailRenderer, "render">;
  private readonly maxCacheBytes: number;
  private readonly inFlight = new Map<string, Promise<ExplorerThumbnail>>();
  private writesSinceEviction = 0;
  private eviction: Promise<void> = Promise.resolve();

  constructor(options: {
    paseoHome: string;
    renderer: Pick<ThumbnailRenderer, "render">;
    maxCacheBytes?: number;
  }) {
    this.directory = path.join(options.paseoHome, "cache", "thumbnails");
    this.renderer = options.renderer;
    this.maxCacheBytes = options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
  }

  /**
   * Same scoping as reading the file itself: `root` is the client's browse root and the path
   * must stay inside it. A changed file gets a new cache entry because its revision is in the key.
   */
  async get(input: {
    root: string;
    relativePath: string;
    maxEdge: number;
  }): Promise<ExplorerThumbnail> {
    const sourcePath = await resolveExplorerFilePath({
      root: input.root,
      relativePath: input.relativePath,
    });
    if (!THUMBNAIL_IMAGE_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) {
      throw new Error("No thumbnail for this file type");
    }
    const stats = await fs.stat(sourcePath, { bigint: true });
    if (!stats.isFile()) throw new Error("Requested path is not a file");
    if (stats.size > BigInt(MAX_THUMBNAIL_SOURCE_BYTES)) {
      throw new Error("Image is too large for a thumbnail");
    }
    const edge = thumbnailEdgeBucket(input.maxEdge);
    const key = createHash("sha256")
      .update(`${sourcePath}\0${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}\0${edge}`)
      .digest("hex");
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const work = this.load(key, sourcePath, edge).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  private async load(key: string, sourcePath: string, edge: number): Promise<ExplorerThumbnail> {
    const cachePath = path.join(this.directory, `${key}.json`);
    const cached = await readCached(cachePath);
    if (cached) {
      const now = new Date();
      await fs.utimes(cachePath, now, now).catch(() => undefined);
      return cached;
    }
    const rendered = await this.renderer.render({ sourcePath, maxEdge: edge });
    const thumbnail: ExplorerThumbnail = {
      mimeType: rendered.mimeType,
      width: rendered.width,
      height: rendered.height,
      data: Buffer.from(rendered.bytes).toString("base64"),
    };
    await fs.mkdir(this.directory, { recursive: true });
    await writeJsonFileAtomic(cachePath, thumbnail);
    this.writesSinceEviction += 1;
    if (this.writesSinceEviction >= EVICTION_INTERVAL_WRITES) {
      this.writesSinceEviction = 0;
      this.eviction = this.eviction.then(() => this.evict()).catch(() => undefined);
    }
    return thumbnail;
  }

  /** Drops least recently used entries until the cache fits. Exposed for tests. */
  async evict(): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.directory);
    } catch {
      return;
    }
    const entries = (
      await Promise.all(
        names
          .filter((name) => name.endsWith(".json"))
          .map(async (name) => {
            const filePath = path.join(this.directory, name);
            const stats = await fs.stat(filePath).catch(() => null);
            return stats ? { filePath, size: stats.size, usedAt: stats.mtimeMs } : null;
          }),
      )
    ).filter((entry) => entry !== null);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    entries.sort((a, b) => a.usedAt - b.usedAt);
    for (const entry of entries) {
      if (total <= this.maxCacheBytes) break;
      await fs.rm(entry.filePath, { force: true });
      total -= entry.size;
    }
  }
}

async function readCached(cachePath: string): Promise<ExplorerThumbnail | null> {
  try {
    return CachedThumbnailSchema.parse(JSON.parse(await fs.readFile(cachePath, "utf8")));
  } catch {
    return null;
  }
}
