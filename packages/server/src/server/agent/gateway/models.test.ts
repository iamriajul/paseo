import { describe, expect, test, vi } from "vitest";

import { fetchGatewayCodexModels, type CliproxyAnthropicModelsWarning } from "./models.js";

function codexResponse(models: unknown[], headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ models }), {
    status: 200,
    headers: { "X-CPA-TRACE-ID": "trace-1", ...headers },
  });
}

describe("fetchGatewayCodexModels", () => {
  const base = { baseUrl: "http://gateway:8317", token: "sk-test" };

  test("maps slugs, reasoning levels, and context windows", async () => {
    const fetchImpl = vi.fn(async () =>
      codexResponse([
        {
          slug: "gpt-6-astra",
          display_name: "GPT 6 Astra",
          description: "Flagship",
          context_window: 272000,
          default_reasoning_level: "high",
          supported_reasoning_levels: [
            { effort: "low", description: "Fast" },
            { effort: "high", description: "Deep" },
          ],
          visibility: ["list"],
        },
      ]),
    );
    const rows = await fetchGatewayCodexModels({ ...base, fetchImpl });
    expect(rows).toEqual([
      {
        slug: "gpt-6-astra",
        displayName: "GPT 6 Astra",
        description: "Flagship",
        contextWindow: 272000,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: ["low", "high"],
        hidden: false,
      },
    ]);
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toBe("http://gateway:8317/v1/models?client_version=0.155.1");
  });

  test("marks hidden rows and filters non-chat models", async () => {
    const fetchImpl = vi.fn(async () =>
      codexResponse([
        { slug: "gpt-image-2", display_name: "GPT Image 2", visibility: "hide" },
        { slug: "grok-imagine-video", display_name: "Imagine Video" },
        { slug: "grok-4.6", display_name: "Grok 4.6", visibility: "hide" },
        { slug: "grok-4.7", display_name: "Grok 4.7", visibility: ["hide"] },
      ]),
    );
    const rows = await fetchGatewayCodexModels({ ...base, fetchImpl });
    expect(rows.map((row) => row.slug)).toEqual(["grok-4.6", "grok-4.7"]);
    expect(rows[0]?.hidden).toBe(true);
  });
  test("dedupes repeated slugs", async () => {
    const fetchImpl = vi.fn(async () =>
      codexResponse([
        { slug: "grok-4.6", display_name: "Grok 4.6" },
        { slug: "grok-4.6", display_name: "Grok 4.6 (dup)" },
      ]),
    );
    expect(await fetchGatewayCodexModels({ ...base, fetchImpl })).toHaveLength(1);
  });
  test("rejects non-gateway endpoints without the fingerprint", async () => {
    const warnings: CliproxyAnthropicModelsWarning[] = [];
    // Plain OpenAI envelope: no header and no Codex models envelope.
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 }),
    );
    const rows = await fetchGatewayCodexModels({
      ...base,
      fetchImpl,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(rows).toEqual([]);
    expect(warnings).toEqual([{ code: "missing_fingerprint", page: 1 }]);
  });

  test("accepts the models envelope without headers as behavioral proof", async () => {
    const warnings: CliproxyAnthropicModelsWarning[] = [];
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ models: [{ slug: "grok-4.6" }] }), { status: 200 }),
    );
    const rows = await fetchGatewayCodexModels({
      ...base,
      fetchImpl,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(rows.map((row) => row.slug)).toEqual(["grok-4.6"]);
    expect(warnings).toEqual([]);
  });

  test("expectGateway skips detection entirely", async () => {
    const warnings: CliproxyAnthropicModelsWarning[] = [];
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ models: [{ slug: "grok-4.6" }] }), { status: 200 }),
    );
    const rows = await fetchGatewayCodexModels({
      ...base,
      expectGateway: true,
      fetchImpl,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(rows.map((row) => row.slug)).toEqual(["grok-4.6"]);
    expect(warnings).toEqual([]);
  });

  test("returns empty on http errors and invalid payloads", async () => {
    const httpError = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(fetchGatewayCodexModels({ ...base, fetchImpl: httpError })).resolves.toEqual([]);
    const badShape = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "X-CPA-TRACE-ID": "trace-1" },
        }),
    );
    await expect(fetchGatewayCodexModels({ ...base, fetchImpl: badShape })).resolves.toEqual([]);
  });
});
