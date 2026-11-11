import { afterEach, describe, expect, test, vi } from "vitest";

import { clearGatewayQuotaCache, fetchGatewayQuota, getCachedGatewayQuota } from "./quota.js";
import { resolveGatewayModelSlug } from "./slug.js";

function quotaResponse(payload: unknown, status = 200): Response {
  return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("resolveGatewayModelSlug", () => {
  test("passes claude and codex ids through with suffixes stripped", () => {
    expect(resolveGatewayModelSlug("claude", "grok-4.6")).toBe("grok-4.6");
    expect(resolveGatewayModelSlug("claude", "claude-fable-5-dd-5.4-korg")).toBe("grok-4.5");
    expect(resolveGatewayModelSlug("claude", "claude-opus-5[1m]")).toBe("claude-opus-5");
    expect(resolveGatewayModelSlug("claude", "grok-4.6(high)")).toBe("grok-4.6");
    expect(resolveGatewayModelSlug("codex", "gpt-6-astra")).toBe("gpt-6-astra");
    expect(resolveGatewayModelSlug("claude", "   ")).toBeNull();
  });

  test("requires gateway provider prefixes for opencode and omp", () => {
    expect(resolveGatewayModelSlug("opencode", "cliproxyapi/grok-4.6")).toBe("grok-4.6");
    expect(resolveGatewayModelSlug("opencode", "openai/gpt-5")).toBeNull();
    expect(resolveGatewayModelSlug("omp", "litellm/grok-4.6")).toBe("grok-4.6");
    expect(resolveGatewayModelSlug("omp", "muse-code/muse-spark-1.3")).toBeNull();
  });

  test("rejects unknown providers", () => {
    expect(resolveGatewayModelSlug("copilot", "gpt-5.4")).toBeNull();
    expect(resolveGatewayModelSlug("pi", "openai/gpt-5")).toBeNull();
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

  test("treats a 404 envelope as no account serving the model", async () => {
    const fetchImpl = vi.fn(async () =>
      quotaResponse({ error: "no credentials serve model" }, 404),
    );
    const result = await fetchGatewayQuota({ ...base, fetchImpl });
    expect(result).toEqual({ supported: true, accounts: [] });
  });

  test("treats other error envelopes as supported with no accounts, and as a failed read", async () => {
    for (const status of [400, 401, 503]) {
      const fetchImpl = vi.fn(async () => quotaResponse({ error: "nope" }, status));
      const result = await fetchGatewayQuota({ ...base, fetchImpl });
      expect(result, `status ${status}`).toEqual({ supported: true, accounts: [], failed: true });
    }
  });

  test("treats a plain 404 as a Gateway without the route", async () => {
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
  });

  test("treats transport failures and other plain errors as unsupported failed reads", async () => {
    const failing = vi.fn(async () => {
      throw new Error("connect refused");
    });
    await expect(fetchGatewayQuota({ ...base, fetchImpl: failing })).resolves.toEqual({
      supported: false,
      accounts: [],
      failed: true,
    });
    const badGateway = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    await expect(fetchGatewayQuota({ ...base, fetchImpl: badGateway })).resolves.toEqual({
      supported: false,
      accounts: [],
      failed: true,
    });
  });

  test("treats invalid 200 payloads as unsupported failed reads", async () => {
    const badShape = vi.fn(async () => quotaResponse({ accounts: [] }));
    await expect(fetchGatewayQuota({ ...base, fetchImpl: badShape })).resolves.toEqual({
      supported: false,
      accounts: [],
      failed: true,
    });
    const badAccount = vi.fn(async () => quotaResponse([{ provider: "xai" }]));
    await expect(fetchGatewayQuota({ ...base, fetchImpl: badAccount })).resolves.toEqual({
      supported: false,
      accounts: [],
      failed: true,
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

  test("reads again past a caller's maxAgeMs, inside the shared TTL", async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn(async () => quotaResponse([]));
    const options = { baseUrl: "http://gateway:8317", token: "sk-test", model: "m", fetchImpl };
    await getCachedGatewayQuota(options, () => now);

    now += 9_000;
    await getCachedGatewayQuota({ ...options, maxAgeMs: 10_000 }, () => now);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 2_000;
    await getCachedGatewayQuota({ ...options, maxAgeMs: 10_000 }, () => now);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // The fresh read refills the cache for everyone.
    await getCachedGatewayQuota(options, () => now);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
