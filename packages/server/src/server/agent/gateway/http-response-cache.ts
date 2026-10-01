import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";

import { writeJsonFileAtomic } from "../../atomic-file.js";
import { resolvePaseoHome } from "../../paseo-home.js";

const CACHE_RELATIVE_PATH = ["cache", "cliproxyapi"] as const;

/**
 * One cached HTTP response per request URL.
 *
 * The payload is stored exactly as the gateway sent it, so every consumer reads
 * the same bytes and no consumer can drift from another through a derived field.
 */
const CachedResponseSchema = z.object({
  fetchedAtMs: z.number(),
  payload: z.unknown(),
});

export interface CachedGatewayResponse {
  fetchedAtMs: number;
  payload: unknown;
}

/** In-memory mirror so a warm daemon never re-reads the file. */
const memoryCache = new Map<string, CachedGatewayResponse>();

/**
 * Cache key for a request. The full URL is encoded, not just its path, so the
 * Anthropic and Codex catalog requests — which differ only by query string —
 * cannot collide on one file.
 */
function cacheKeyForUrl(url: string): string {
  return Buffer.from(url, "utf8").toString("base64url");
}

/**
 * Resolve the cache file for a request URL, or null when caching is disabled.
 *
 * Tests run under two different vitest configs — the repo root one has no setup
 * files — so isolation cannot rely on $PASEO_HOME being redirected. This env flag
 * makes the guarantee hold regardless of which runner a suite uses.
 */
export function gatewayCacheFilePath(url: string): string | null {
  if (process.env.PASEO_DISABLE_GATEWAY_CACHE === "1") {
    return null;
  }
  return path.join(resolvePaseoHome(), ...CACHE_RELATIVE_PATH, `${cacheKeyForUrl(url)}.json`);
}

export function resetGatewayResponseCacheForTests(): void {
  memoryCache.clear();
}

/**
 * Read a cached gateway response, or null when it was never written or is
 * unreadable. A damaged cache file is a miss, never a boot failure.
 */
export async function readCachedGatewayResponse(
  url: string,
): Promise<CachedGatewayResponse | null> {
  const key = cacheKeyForUrl(url);
  const cached = memoryCache.get(key);
  if (cached) {
    return cached;
  }

  const filePath = gatewayCacheFilePath(url);
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
    payload: parsed.data.payload,
  };
  memoryCache.set(key, response);
  return response;
}

/**
 * Cache a gateway response. Best-effort: a failed write leaves the daemon working
 * from the live response, so callers do not need to handle a write error.
 */
export async function writeCachedGatewayResponse(url: string, payload: unknown): Promise<void> {
  const response: CachedGatewayResponse = { fetchedAtMs: Date.now(), payload };
  memoryCache.set(cacheKeyForUrl(url), response);
  const filePath = gatewayCacheFilePath(url);
  if (!filePath) {
    return;
  }
  try {
    await writeJsonFileAtomic(filePath, response);
  } catch {
    // Disk cache is best-effort; the in-memory copy still serves this session.
  }
}
