import type { ViewportSize } from "@/components/zoomable-viewport/geometry";

export interface GalleryImageTarget {
  serverId: string;
  cwd: string;
  path: string;
}

export interface LoadedGalleryImage {
  url: string;
  /** The file version the URL shows: its revision, or size and modified time. */
  version: string;
  /** Pixel size, measured while loading so the viewer fits it without a second pass. */
  size: ViewportSize | null;
  release: () => void;
}

export type GalleryImageState =
  | { status: "loading" }
  | { status: "ready"; url: string; size: ViewportSize | null }
  | { status: "error"; message: string };

export type GalleryImageLoader = (target: GalleryImageTarget) => Promise<LoadedGalleryImage>;

interface Entry {
  target: GalleryImageTarget;
  state: GalleryImageState;
  loaded: LoadedGalleryImage | null;
  generation: number;
  refs: number;
  lastUsed: number;
}

const LOADING: GalleryImageState = { status: "loading" };

/**
 * Image URLs for the gallery, shared by the image on screen and the neighbours it preloads, so a
 * page lands on an image that is already read and decoded. Retained entries stay; up to
 * `idleLimit` released ones stay too, so paging back is instant, and older ones free their URL.
 */
export class GalleryImageCache {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private clock = 0;

  constructor(
    private readonly load: GalleryImageLoader,
    private readonly idleLimit = 6,
  ) {}

  getState = (key: string): GalleryImageState => this.entries.get(key)?.state ?? LOADING;

  subscribe = (key: string, listener: () => void): (() => void) => {
    let listeners = this.listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  };

  /**
   * Keeps the image loaded until the returned function runs. A known `version` that differs from
   * the loaded one reloads it: the file changed on disk.
   */
  retain(key: string, target: GalleryImageTarget, version: string | null): () => void {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        target,
        state: LOADING,
        loaded: null,
        generation: 0,
        refs: 0,
        lastUsed: 0,
      };
      this.entries.set(key, entry);
      this.start(key, entry);
    } else if (
      (version && entry.loaded && entry.loaded.version !== version) ||
      entry.state.status === "error"
    ) {
      this.start(key, entry);
    }
    entry.refs += 1;
    entry.lastUsed = ++this.clock;
    const held = entry;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      held.lastUsed = ++this.clock;
      this.evict();
    };
  }

  private start(key: string, entry: Entry): void {
    void this.run(key, entry, ++entry.generation);
  }

  private async run(key: string, entry: Entry, generation: number): Promise<void> {
    let loaded: LoadedGalleryImage;
    try {
      loaded = await this.load(entry.target);
    } catch (error) {
      if (entry.generation !== generation) return;
      const message = error instanceof Error ? error.message : String(error);
      this.setState(key, entry, { status: "error", message });
      return;
    }
    if (entry.generation !== generation) {
      loaded.release();
      return;
    }
    entry.loaded?.release();
    entry.loaded = loaded;
    this.setState(key, entry, { status: "ready", url: loaded.url, size: loaded.size });
  }

  private setState(key: string, entry: Entry, state: GalleryImageState): void {
    entry.state = state;
    for (const listener of this.listeners.get(key) ?? []) listener();
  }

  private evict(): void {
    const idle = [...this.entries.entries()]
      .filter(([, entry]) => entry.refs === 0)
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
    for (const [key, entry] of idle.slice(0, Math.max(0, idle.length - this.idleLimit))) {
      this.entries.delete(key);
      // A load still in flight for this entry releases its URL when it lands.
      entry.generation += 1;
      entry.loaded?.release();
    }
  }
}
