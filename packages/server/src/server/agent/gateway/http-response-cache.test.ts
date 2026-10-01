import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  GATEWAY_CACHE_MAX_AGE_MS,
  gatewayCacheFilePath,
  readCachedGatewayResponse,
  resetGatewayResponseCacheForTests,
  writeCachedGatewayResponse,
} from "./http-response-cache.js";

describe("gateway http response cache", () => {
  let paseoHome: string;
  const FIRST_PAGE_URL = "http://gw.example/v1/models";

  beforeEach(async () => {
    paseoHome = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-gw-cache-"));
    // Both vitest configs disable gateway caching globally; this suite is the one
    // place that must exercise it for real.
    vi.stubEnv("PASEO_DISABLE_GATEWAY_CACHE", "0");
    vi.stubEnv("PASEO_HOME", paseoHome);
    resetGatewayResponseCacheForTests();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetGatewayResponseCacheForTests();
    await fs.rm(paseoHome, { recursive: true, force: true });
  });

  function gatewayPage(maxInputTokens: number) {
    return {
      data: [
        {
          id: "muse-spark-1.3",
          display_name: "MuseSpark 1.3",
          owned_by: "upstream",
          max_input_tokens: maxInputTokens,
          max_tokens: 131_072,
        },
      ],
      has_more: false,
    };
  }

  test("returns nothing before anything is cached", async () => {
    expect(await readCachedGatewayResponse(FIRST_PAGE_URL)).toBeNull();
  });

  test("round-trips every page under one file", async () => {
    const secondPageUrl = "http://gw.example/v1/models?after_id=abc";
    await writeCachedGatewayResponse(FIRST_PAGE_URL, {
      [FIRST_PAGE_URL]: gatewayPage(1_048_576),
      [secondPageUrl]: gatewayPage(524_288),
    });

    const cached = await readCachedGatewayResponse(FIRST_PAGE_URL);

    expect(Object.keys(cached?.pages ?? {})).toEqual([FIRST_PAGE_URL, secondPageUrl]);
    expect(cached?.pages[FIRST_PAGE_URL]).toEqual(gatewayPage(1_048_576));
  });

  test("keys distinct catalogs to distinct files", async () => {
    const anthropic = FIRST_PAGE_URL;
    const codex = "http://gw.example/v1/models?client_version=0.155.1";
    await writeCachedGatewayResponse(anthropic, { [anthropic]: gatewayPage(1_000_000) });
    await writeCachedGatewayResponse(codex, { [codex]: { models: [{ slug: "grok-4.5" }] } });

    expect(gatewayCacheFilePath(anthropic)).not.toBe(gatewayCacheFilePath(codex));
    expect(Object.keys((await readCachedGatewayResponse(codex))?.pages ?? {})).toEqual([codex]);
  });

  test("misses rather than returning another catalog's pages", async () => {
    await writeCachedGatewayResponse(FIRST_PAGE_URL, {
      [FIRST_PAGE_URL]: gatewayPage(1_000_000),
    });

    expect(
      await readCachedGatewayResponse("http://gw.example/v1/models?client_version=2"),
    ).toBeNull();
  });

  test("degrades to a miss when the cached file is corrupt", async () => {
    await writeCachedGatewayResponse(FIRST_PAGE_URL, {
      [FIRST_PAGE_URL]: gatewayPage(1_000_000),
    });
    const filePath = gatewayCacheFilePath(FIRST_PAGE_URL);
    await fs.writeFile(filePath!, "{not json", "utf8");
    resetGatewayResponseCacheForTests();

    expect(await readCachedGatewayResponse(FIRST_PAGE_URL)).toBeNull();
  });

  test("ignores a catalog older than the max age", async () => {
    await writeCachedGatewayResponse(FIRST_PAGE_URL, {
      [FIRST_PAGE_URL]: gatewayPage(1_000_000),
    });

    const laterThanMaxAge = await readCachedGatewayResponse(FIRST_PAGE_URL, {
      now: () => Date.now() + GATEWAY_CACHE_MAX_AGE_MS + 1,
    });

    expect(laterThanMaxAge).toBeNull();
  });

  test("still serves a catalog within the max age", async () => {
    await writeCachedGatewayResponse(FIRST_PAGE_URL, {
      [FIRST_PAGE_URL]: gatewayPage(1_000_000),
    });

    const withinMaxAge = await readCachedGatewayResponse(FIRST_PAGE_URL, {
      now: () => Date.now() + GATEWAY_CACHE_MAX_AGE_MS - 1,
    });

    expect(withinMaxAge?.pages[FIRST_PAGE_URL]).toEqual(gatewayPage(1_000_000));
  });

  test("caches under the shared cliproxyapi cache folder", () => {
    const filePath = gatewayCacheFilePath(FIRST_PAGE_URL);

    expect(filePath!.startsWith(path.join(paseoHome, "cache", "cliproxyapi"))).toBe(true);
    expect(path.extname(filePath!)).toBe(".json");
  });

  describe("when PASEO_DISABLE_GATEWAY_CACHE=1", () => {
    beforeEach(() => {
      vi.stubEnv("PASEO_DISABLE_GATEWAY_CACHE", "1");
    });

    test("writes nothing to disk", async () => {
      await writeCachedGatewayResponse(FIRST_PAGE_URL, {
        [FIRST_PAGE_URL]: gatewayPage(1_000_000),
      });

      expect(gatewayCacheFilePath(FIRST_PAGE_URL)).toBeNull();
      await expect(fs.readdir(path.join(paseoHome, "cache", "cliproxyapi"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    test("neither reads nor populates memory, whatever the order", async () => {
      // A discovery that ran before the flag was set must not leak into a later
      // read in the same process.
      await writeCachedGatewayResponse(FIRST_PAGE_URL, {
        [FIRST_PAGE_URL]: gatewayPage(1_000_000),
      });
      vi.stubEnv("PASEO_DISABLE_GATEWAY_CACHE", "1");
      resetGatewayResponseCacheForTests();

      expect(await readCachedGatewayResponse(FIRST_PAGE_URL)).toBeNull();

      vi.stubEnv("PASEO_DISABLE_GATEWAY_CACHE", "0");
      expect(await readCachedGatewayResponse(FIRST_PAGE_URL)).toBeNull();
    });
  });
});
