import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";

import { writeJsonFileAtomic } from "../../atomic-file.js";
import { resolvePaseoHome } from "../../paseo-home.js";

const CACHE_RELATIVE_PATH = ["cache", "cliproxyapi"] as const;

/**
 * How long a cached catalog may stand in for the gateway.
 *
 * The fallback exists for a boot where the gateway is unreachable, so the useful
 * window is hours, not weeks. Past this a stale window is worse than none: an
 * over-estimate buys a context-length error from the backend, and an under-estimate
 * silently compacts again — the failure this cache exists to prevent.
 */
export const GATEWAY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * One cached HTTP response per catalog. Pages are stored exactly as the gateway
 * sent them, so every consumer reads the same bytes and no consumer can drift from
 * another through a derived field.
 */
const CachedResponseSchema = z.object({
  fetchedAtMs: z.number(),
  /** One entry per request URL: the first page, then each `after_id` page. */
  pages: z.record(z.string(), z.unknown()),
});

export interface CachedGatewayResponse {
  fetchedAtMs: number;
  pages: Record<string, unknown>;
}

/** In-memory mirror so a warm daemon never re-reads the file. */
const memoryCache = new Map<string, CachedGatewayResponse>();

function cacheDisabled(): boolean {
  return process.env.PASEO_DISABLE_GATEWAY_CACHE === "1";
}

/**
 * Cache key for a catalog. The full URL is encoded, not just its path, so the
 * Anthropic and Codex catalog requests — which differ only by query string — cannot
 * collide, and so every page of one catalog shares a single file.
 */
function cacheKeyForUrl(url: string): string {
  return Buffer.from(url, "utf8").toString("base64url");
}

/**
 * The file backing a catalog, keyed by the gateway's first-page URL. Null when
 * caching is disabled, which both vitest configs request so no suite writes a
 * gateway cache into a real `$PASEO_HOME`.
 */
export function gatewayCacheFilePath(firstPageUrl: string): string | null {
  if (cacheDisabled()) {
    return null;
  }
  return path.join(
    resolvePaseoHome(),
    ...CACHE_RELATIVE_PATH,
    `${cacheKeyForUrl(firstPageUrl)}.json`,
  );
}

export function resetGatewayResponseCacheForTests(): void {
  memoryCache.clear();
}

async function readCachedEntry(firstPageUrl: string): Promise<CachedGatewayResponse | null> {
  const key = cacheKeyForUrl(firstPageUrl);
  const cached = memoryCache.get(key);
  if (cached) {
    return cached;
  }

  const filePath = gatewayCacheFilePath(firstPageUrl);
  if (!filePath) {
    return null;
  }

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    // A truncated or hand-edited cache file is a miss, not a boot failure.
    return null;
  }

  const parsed = CachedResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return null;
  }

  const response: CachedGatewayResponse = {
    fetchedAtMs: parsed.data.fetchedAtMs,
    pages: parsed.data.pages,
  };
  memoryCache.set(key, response);
  return response;
}

/**
 * Read a cached catalog, or null when it was never written, is unreadable, or has
 * aged out. Every failure here returns a miss rather than throwing, because this
 * runs on the daemon's startup path.
 */
export async function readCachedGatewayResponse(
  firstPageUrl: string,
  options: { now?: () => number; maxAgeMs?: number } = {},
): Promise<CachedGatewayResponse | null> {
  if (cacheDisabled()) {
    return null;
  }
  const entry = await readCachedEntry(firstPageUrl);
  if (!entry) {
    return null;
  }
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? GATEWAY_CACHE_MAX_AGE_MS;
  if (now() - entry.fetchedAtMs > maxAgeMs) {
    return null;
  }
  return entry;
}

/**
 * Cache the catalog pages discovery just consumed. Best-effort: a failed write
 * leaves the daemon working from the live catalog.
 */
export async function writeCachedGatewayResponse(
  firstPageUrl: string,
  pages: Record<string, unknown>,
): Promise<void> {
  if (cacheDisabled()) {
    return;
  }
  const entry: CachedGatewayResponse = { fetchedAtMs: Date.now(), pages };
  memoryCache.set(cacheKeyForUrl(firstPageUrl), entry);
  const filePath = gatewayCacheFilePath(firstPageUrl);
  if (!filePath) {
    return;
  }
  try {
    await writeJsonFileAtomic(filePath, entry);
  } catch {
    // Disk cache is best-effort; the in-memory copy still serves this session.
  }
}
