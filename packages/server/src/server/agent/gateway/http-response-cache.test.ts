import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  gatewayCacheFilePath,
  readCachedGatewayResponse,
  resetGatewayResponseCacheForTests,
  writeCachedGatewayResponse,
} from "./http-response-cache.js";

describe("gateway http response cache", () => {
  let paseoHome: string;

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

  function gatewayPayload(maxInputTokens: number) {
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
    expect(await readCachedGatewayResponse("http://gw.example/v1/models")).toBeNull();
  });

  test("round-trips the raw payload for a URL", async () => {
    const url = "http://gw.example/v1/models";
    const payload = gatewayPayload(1_048_576);
    await writeCachedGatewayResponse(url, payload);

    const cached = await readCachedGatewayResponse(url);

    expect(cached?.payload).toEqual(payload);
    expect(cached?.fetchedAtMs).toBeGreaterThan(0);
  });

  test("keys distinct query strings to distinct files", async () => {
    const anthropic = "http://gw.example/v1/models";
    const codex = "http://gw.example/v1/models?client_version=0.155.1";
    await writeCachedGatewayResponse(anthropic, gatewayPayload(1_000_000));
    await writeCachedGatewayResponse(codex, { models: [{ slug: "grok-4.5" }] });

    expect(gatewayCacheFilePath(anthropic)).not.toBe(gatewayCacheFilePath(codex));
    expect((await readCachedGatewayResponse(anthropic))?.payload).toEqual(
      gatewayPayload(1_000_000),
    );
    expect((await readCachedGatewayResponse(codex))?.payload).toEqual({
      models: [{ slug: "grok-4.5" }],
    });
  });

  test("a later read for an unwritten URL misses instead of returning another URL's payload", async () => {
    await writeCachedGatewayResponse("http://gw.example/v1/models?client_version=1", {
      models: [{ slug: "a" }],
    });

    expect(
      await readCachedGatewayResponse("http://gw.example/v1/models?client_version=2"),
    ).toBeNull();
  });

  test("degrades to a miss when the cached file is corrupt", async () => {
    const url = "http://gw.example/v1/models";
    await writeCachedGatewayResponse(url, gatewayPayload(1_000_000));
    const filePath = gatewayCacheFilePath(url);
    await fs.writeFile(filePath, "{not json", "utf8");
    resetGatewayResponseCacheForTests();

    expect(await readCachedGatewayResponse(url)).toBeNull();
  });

  test("caches under the shared cliproxyapi cache folder", async () => {
    const filePath = gatewayCacheFilePath("http://gw.example/v1/models");

    expect(filePath.startsWith(path.join(paseoHome, "cache", "cliproxyapi"))).toBe(true);
    expect(path.extname(filePath)).toBe(".json");
  });
});
