import { describe, expect, test, vi } from "vitest";

import { fetchGatewayTps } from "./tps.js";

function tpsResponse(payload: unknown, status = 200): Response {
  return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const record = {
  model: "grok-4.6",
  alias: "space-bunny-free",
  provider: "xai",
  at: "2026-09-28T10:00:00Z",
  duration_ms: 4200,
  ttft_ms: 600,
  generation_ms: 3600,
  input_tokens: 1200,
  output_tokens: 900,
  tps: 250,
  stream: true,
};

describe("fetchGatewayTps", () => {
  const base = { baseUrl: "http://gateway:8317", token: "sk-test", model: "grok-4.6" };

  test("maps a last-request record and requests the model filter", async () => {
    const fetchImpl = vi.fn(async () => tpsResponse(record));

    const result = await fetchGatewayTps({ ...base, fetchImpl });

    expect(result).toEqual({
      supported: true,
      sample: {
        model: "grok-4.6",
        alias: "space-bunny-free",
        provider: "xai",
        at: "2026-09-28T10:00:00Z",
        durationMs: 4200,
        ttftMs: 600,
        generationMs: 3600,
        inputTokens: 1200,
        outputTokens: 900,
        tps: 250,
        stream: true,
      },
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "http://gateway:8317/v1/last-request-tps?model=grok-4.6",
    );
  });

  test("omits the model filter for the newest request across every model", async () => {
    const fetchImpl = vi.fn(async () => tpsResponse(record));

    await fetchGatewayTps({ ...base, model: "", fetchImpl });

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://gateway:8317/v1/last-request-tps");
  });

  test("reports no sample when the model has never run", async () => {
    // The endpoint's 404 is the "no record" state, not a missing route: both
    // render nothing, so a caller cannot tell them apart and must not try.
    const fetchImpl = vi.fn(async () => tpsResponse({ error: "no request recorded" }, 404));

    await expect(fetchGatewayTps({ ...base, fetchImpl })).resolves.toEqual({
      supported: false,
      sample: null,
    });
  });

  test("reports no sample for a rejected key, missing route, or transport failure", async () => {
    const unauthorized = vi.fn(async () => tpsResponse({ error: "unauthorized" }, 401));
    await expect(fetchGatewayTps({ ...base, fetchImpl: unauthorized })).resolves.toEqual({
      supported: false,
      sample: null,
    });

    const emptyRoute = vi.fn(async () => new Response("", { status: 404 }));
    await expect(fetchGatewayTps({ ...base, fetchImpl: emptyRoute })).resolves.toEqual({
      supported: false,
      sample: null,
    });

    const failing = vi.fn(async () => {
      throw new Error("connect refused");
    });
    await expect(fetchGatewayTps({ ...base, fetchImpl: failing })).resolves.toEqual({
      supported: false,
      sample: null,
    });
  });

  test("rejects a 200 record with missing, negative, or unparseable fields", async () => {
    const cases: Array<Record<string, unknown>> = [
      { ...record, tps: undefined },
      { ...record, tps: Number.NaN },
      { ...record, output_tokens: -1 },
      { ...record, generation_ms: "1200" },
      { ...record, at: "not-a-date" },
      { ...record, at: "  " },
      { ...record, stream: "yes" },
    ];

    for (const payload of cases) {
      const fetchImpl = vi.fn(async () => tpsResponse(payload));
      await expect(
        fetchGatewayTps({ ...base, fetchImpl }),
        JSON.stringify(payload),
      ).resolves.toEqual({ supported: false, sample: null });
    }
  });

  test("keeps a record that omits the optional alias and provider", async () => {
    const fetchImpl = vi.fn(async () => {
      const { alias: _alias, provider: _provider, ...rest } = record;
      return tpsResponse(rest);
    });

    const result = await fetchGatewayTps({ ...base, fetchImpl });

    expect(result.supported).toBe(true);
    expect(result.sample).toMatchObject({ model: "grok-4.6", tps: 250 });
    expect(result.sample).not.toHaveProperty("alias");
    expect(result.sample).not.toHaveProperty("provider");
  });

  test("reports no sample when the gateway has no usable base url", async () => {
    const fetchImpl = vi.fn();

    await expect(fetchGatewayTps({ ...base, baseUrl: "  ", fetchImpl })).resolves.toEqual({
      supported: false,
      sample: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
