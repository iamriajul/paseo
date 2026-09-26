import { afterEach, describe, expect, test, vi } from "vitest";

import {
  clearGatewayQuotaCache,
  fetchGatewayQuota,
  getCachedGatewayQuota,
  resolveGatewayQuotaSlug,
} from "./quota.js";

function quotaResponse(payload: unknown, status = 200): Response {
  return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("resolveGatewayQuotaSlug", () => {
  test("passes claude and codex ids through with suffixes stripped", () => {
    expect(resolveGatewayQuotaSlug("claude", "grok-4.6")).toBe("grok-4.6");
    expect(resolveGatewayQuotaSlug("claude", "claude-fable-5-dd-5.4-korg")).toBe("grok-4.5");
    expect(resolveGatewayQuotaSlug("claude", "claude-opus-5[1m]")).toBe("claude-opus-5");
    expect(resolveGatewayQuotaSlug("claude", "grok-4.6(high)")).toBe("grok-4.6");
    expect(resolveGatewayQuotaSlug("codex", "gpt-6-astra")).toBe("gpt-6-astra");
    expect(resolveGatewayQuotaSlug("claude", "   ")).toBeNull();
  });

  test("requires gateway provider prefixes for opencode and omp", () => {
    expect(resolveGatewayQuotaSlug("opencode", "cliproxyapi/grok-4.6")).toBe("grok-4.6");
    expect(resolveGatewayQuotaSlug("opencode", "openai/gpt-5")).toBeNull();
    expect(resolveGatewayQuotaSlug("omp", "litellm/grok-4.6")).toBe("grok-4.6");
    expect(resolveGatewayQuotaSlug("omp", "muse-code/muse-spark-1.3")).toBeNull();
  });

  test("rejects unknown providers", () => {
    expect(resolveGatewayQuotaSlug("copilot", "gpt-5.4")).toBeNull();
    expect(resolveGatewayQuotaSlug("pi", "openai/gpt-5")).toBeNull();
  });
});

describe("fetchGatewayQuota", () => {
  const base = { baseUrl: "http://gateway:8317", token: "sk-test", model: "grok-4.6" };

  test("maps accounts and windows from a 200 payload", async () => {
    const fetchImpl = vi.fn(async () =>
      quotaResponse([
        {
          provider: "xai",
          name: "xai-a***b.json",
          type: "oauth",
          plan: "Pro",
          in_cooldown: false,
          windows_observed_at: "2026-09-25T13:51:28Z",
          windows: [
            { name: "5h", used_percent: 51, reset_at: "2026-09-25T15:00:00Z" },
            { name: "7d", used_percent: 3 },
          ],
        },
      ]),
    );
    const result = await fetchGatewayQuota({ ...base, fetchImpl });
    expect(result.supported).toBe(true);
    expect(result.accounts).toEqual([
      {
        provider: "xai",
        name: "xai-a***b.json",
        type: "oauth",
        plan: "Pro",
        inCooldown: false,
        windowsObservedAt: "2026-09-25T13:51:28Z",
        windows: [
          { name: "5h", usedPct: 51, resetsAt: "2026-09-25T15:00:00Z" },
          { name: "7d", usedPct: 3 },
        ],
      },
    ]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "http://gateway:8317/v1/quota?model=grok-4.6",
    );
  });

  test("omits the model filter when listing every account", async () => {
    const fetchImpl = vi.fn(async () => quotaResponse([]));
    await fetchGatewayQuota({
      baseUrl: "http://gateway:8317",
      token: "sk-test",
      model: "",
      fetchImpl,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://gateway:8317/v1/quota");
  });
  test("drops out-of-range and malformed fields while keeping the account", async () => {
    const fetchImpl = vi.fn(async () =>
      quotaResponse([
        {
          provider: "xai",
          type: "oauth",
          in_cooldown: true,
          windows_observed_at: "not-a-date",
          windows: [
            { name: "5h", used_percent: 500, reset_at: "also-bad" },
            { name: "7d", used_percent: -1 },
          ],
        },
      ]),
    );
    const result = await fetchGatewayQuota({ ...base, fetchImpl });
    expect(result).toEqual({
      supported: true,
      accounts: [
        {
          provider: "xai",
          type: "oauth",
          inCooldown: true,
          windows: [{ name: "5h" }, { name: "7d" }],
        },
      ],
    });
  });

  test("treats error envelopes as supported with no accounts", async () => {
    for (const status of [400, 401, 404, 503]) {
      const fetchImpl = vi.fn(async () => quotaResponse({ error: "nope" }, status));
      const result = await fetchGatewayQuota({ ...base, fetchImpl });
      expect(result, `status ${status}`).toEqual({ supported: true, accounts: [] });
    }
  });

  test("treats missing routes and transport failures as unsupported", async () => {
    const empty404 = vi.fn(async () => new Response("", { status: 404 }));
    await expect(fetchGatewayQuota({ ...base, fetchImpl: empty404 })).resolves.toEqual({
      supported: false,
      accounts: [],
    });
    const html404 = vi.fn(async () => new Response("<html>nope</html>", { status: 404 }));
    await expect(fetchGatewayQuota({ ...base, fetchImpl: html404 })).resolves.toEqual({
      supported: false,
      accounts: [],
    });
    const failing = vi.fn(async () => {
      throw new Error("connect refused");
    });
    await expect(fetchGatewayQuota({ ...base, fetchImpl: failing })).resolves.toEqual({
      supported: false,
      accounts: [],
    });
  });

  test("treats invalid 200 payloads as unsupported", async () => {
    const badShape = vi.fn(async () => quotaResponse({ accounts: [] }));
    await expect(fetchGatewayQuota({ ...base, fetchImpl: badShape })).resolves.toEqual({
      supported: false,
      accounts: [],
    });
    const badAccount = vi.fn(async () => quotaResponse([{ provider: "xai" }]));
    await expect(fetchGatewayQuota({ ...base, fetchImpl: badAccount })).resolves.toEqual({
      supported: false,
      accounts: [],
    });
  });
});

describe("getCachedGatewayQuota", () => {
  afterEach(() => {
    clearGatewayQuotaCache();
  });

  test("shares one flight and caches the result", async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn(async () => quotaResponse([]));
    const options = {
      baseUrl: "http://gateway:8317",
      token: "sk-test",
      model: "grok-4.6",
      fetchImpl,
    };
    const [first, second] = await Promise.all([
      getCachedGatewayQuota(options, () => now),
      getCachedGatewayQuota(options, () => now),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);

    now += 30_000;
    await getCachedGatewayQuota(options, () => now);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 61_000;
    await getCachedGatewayQuota(options, () => now);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
