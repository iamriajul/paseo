import { describe, expect, test, vi } from "vitest";
import {
  appendCliproxyModelsToClaudeCatalog,
  mergeAdditionalModelLimits,
  resolveCliproxyAnthropicCredentials,
} from "./cliproxy-models.js";
import {
  CLIPROXY_MODELS_MAX_PAGES,
  decodeCliproxyClaudeModelId,
  fetchCliproxyAnthropicModels,
  isCliproxyNonChatModel,
  isOfficialCpaOwner,
  responseHasCpaFingerprint,
} from "../../gateway/models.js";

describe("decodeCliproxyClaudeModelId", () => {
  test("decodes reversed non-claude ids", () => {
    expect(decodeCliproxyClaudeModelId("claude-fable-5-dd-5.4-korg")).toBe("grok-4.5");
    expect(decodeCliproxyClaudeModelId("claude-fable-5-dd-los-6.5-tpg")).toBe("gpt-5.6-sol");
    expect(decodeCliproxyClaudeModelId("claude-fable-5-dd-xam-8.3newq")).toBe("qwen3.8-max");
  });

  test("leaves real claude ids unchanged", () => {
    expect(decodeCliproxyClaudeModelId("claude-fable-5")).toBe("claude-fable-5");
    expect(decodeCliproxyClaudeModelId("claude-opus-5")).toBe("claude-opus-5");
  });

  test("preserves thinking suffix on encoded ids", () => {
    expect(decodeCliproxyClaudeModelId("claude-fable-5-dd-5.4-korg(high)")).toBe("grok-4.5(high)");
  });
});

describe("isOfficialCpaOwner", () => {
  test("accepts official brands case-insensitively", () => {
    expect(isOfficialCpaOwner("openai")).toBe(true);
    expect(isOfficialCpaOwner("Anthropic")).toBe(true);
    expect(isOfficialCpaOwner("xAI")).toBe(true);
    expect(isOfficialCpaOwner("antigravity")).toBe(true);
  });

  test("rejects openai-compat and empty", () => {
    expect(isOfficialCpaOwner("OpenCodeGo")).toBe(false);
    expect(isOfficialCpaOwner("")).toBe(false);
    expect(isOfficialCpaOwner(undefined)).toBe(false);
  });
});

describe("isCliproxyNonChatModel", () => {
  test("filters image and video models by decoded id", () => {
    expect(isCliproxyNonChatModel({ id: "gpt-image-2" })).toBe(true);
    expect(isCliproxyNonChatModel({ id: "grok-imagine-video" })).toBe(true);
    expect(isCliproxyNonChatModel({ id: "grok-4.5", displayName: "Grok 4.5" })).toBe(false);
  });
});

describe("resolveCliproxyAnthropicCredentials", () => {
  test("prefers process env over settings.json", async () => {
    const resolved = await resolveCliproxyAnthropicCredentials({
      env: {
        ANTHROPIC_BASE_URL: "http://env.example",
        ANTHROPIC_AUTH_TOKEN: "env-token",
      },
      readSettingsEnv: async () => ({
        ANTHROPIC_BASE_URL: "http://settings.example",
        ANTHROPIC_AUTH_TOKEN: "settings-token",
      }),
    });
    expect(resolved).toEqual({
      baseUrl: "http://env.example",
      token: "env-token",
    });
  });

  test("falls back to settings.json env", async () => {
    const resolved = await resolveCliproxyAnthropicCredentials({
      env: {},
      readSettingsEnv: async () => ({
        ANTHROPIC_BASE_URL: "http://settings.example/",
        ANTHROPIC_AUTH_TOKEN: " settings-token ",
      }),
    });
    expect(resolved).toEqual({
      baseUrl: "http://settings.example",
      token: "settings-token",
    });
  });

  test("returns null when either key missing", async () => {
    expect(
      await resolveCliproxyAnthropicCredentials({
        env: { ANTHROPIC_BASE_URL: "http://x" },
        readSettingsEnv: async () => ({}),
      }),
    ).toBeNull();
  });
});

describe("fetchCliproxyAnthropicModels", () => {
  test("recognizes X-CPA fingerprints case-insensitively", () => {
    expect(responseHasCpaFingerprint(new Headers({ "X-cPa-Version": "1" }))).toBe(true);
    expect(responseHasCpaFingerprint(new Headers({ "x-other-header": "1" }))).toBe(false);
  });

  test("returns empty when response lacks X-CPA fingerprint", async () => {
    const warnings: unknown[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [], has_more: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const rows = await fetchCliproxyAnthropicModels({
      baseUrl: "http://cpa.example",
      token: "t",
      fetchImpl,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(rows).toEqual([]);
    expect(warnings).toEqual([{ code: "missing_fingerprint", page: 1 }]);
  });

  test("accepts rewritten ids without headers as behavioral proof", async () => {
    const warnings: unknown[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "claude-fable-5-dd-5.4-korg",
                display_name: "Grok 4.5",
                owned_by: "xai",
                max_input_tokens: 500000,
                max_tokens: 65536,
              },
            ],
            has_more: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const rows = await fetchCliproxyAnthropicModels({
      baseUrl: "http://cpa.example",
      token: "t",
      fetchImpl,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(rows.map((row) => row.id)).toEqual(["grok-4.5"]);
    expect(warnings).toEqual([]);
  });

  test("expectGateway skips detection entirely", async () => {
    const warnings: unknown[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "claude-opus-4-8", display_name: "Opus 4.8", owned_by: "anthropic" }],
            has_more: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const rows = await fetchCliproxyAnthropicModels({
      baseUrl: "http://cpa.example",
      token: "t",
      expectGateway: true,
      fetchImpl,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(rows.map((row) => row.id)).toEqual(["claude-opus-4-8"]);
    expect(warnings).toEqual([]);
  });

  test("reports first-page failures with safe structured warnings", async () => {
    const cases: Array<{
      fetchImpl: typeof fetch;
      warning: unknown;
    }> = [
      {
        fetchImpl: vi.fn(async () => {
          throw new Error("request failed for Bearer secret-token");
        }),
        warning: { code: "request_failed", page: 1 },
      },
      {
        fetchImpl: vi.fn(
          async () =>
            new Response("unauthorized", {
              status: 401,
              headers: { "x-cpa-version": "1" },
            }),
        ),
        warning: { code: "http_error", page: 1, status: 401 },
      },
      {
        fetchImpl: vi.fn(
          async () =>
            new Response("not-json", {
              status: 200,
              headers: { "x-cpa-version": "1" },
            }),
        ),
        warning: { code: "invalid_json", page: 1 },
      },
    ];

    for (const { fetchImpl, warning } of cases) {
      const warnings: unknown[] = [];
      const rows = await fetchCliproxyAnthropicModels({
        baseUrl: "http://cpa.example",
        token: "secret-token",
        fetchImpl,
        onWarning: (nextWarning) => warnings.push(nextWarning),
      });

      expect(rows).toEqual([]);
      expect(warnings).toEqual([warning]);
      expect(JSON.stringify(warnings)).not.toContain("secret-token");
    }
  });

  test("loads single page when has_more is false", async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
      requestInit = init;
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "claude-fable-5-dd-5.4-korg",
              display_name: "Grok 4.5",
              owned_by: "xai",
              max_input_tokens: 500000,
              max_tokens: 65536,
            },
          ],
          has_more: false,
          first_id: "claude-fable-5-dd-5.4-korg",
          last_id: "claude-fable-5-dd-5.4-korg",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-cpa-version": "1",
          },
        },
      );
    });
    const rows = await fetchCliproxyAnthropicModels({
      baseUrl: "http://cpa.example",
      token: "t",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestInit?.method).toBe("GET");
    const requestHeaders = new Headers(requestInit?.headers);
    expect(requestHeaders.get("authorization")).toBe("Bearer t");
    expect(requestHeaders.get("anthropic-version")).toBe("2023-06-01");
    expect(requestHeaders.get("user-agent")).toBe("claude-cli/paseo");
    expect(rows).toEqual([
      {
        id: "grok-4.5",
        label: "Grok 4.5",
        ownedBy: "xai",
        maxInputTokens: 500000,
        maxOutputTokens: 65536,
        rawListId: "claude-fable-5-dd-5.4-korg",
      },
    ]);
  });

  test("follows after_id while has_more is true and dedupes", async () => {
    const pages = [
      {
        data: [
          {
            id: "claude-a",
            display_name: "A",
            owned_by: "anthropic",
            max_input_tokens: 200000,
            max_tokens: 64000,
          },
        ],
        has_more: true,
        last_id: "claude-a",
      },
      {
        data: [
          {
            id: "claude-a",
            display_name: "A",
            owned_by: "anthropic",
            max_input_tokens: 200000,
            max_tokens: 64000,
          },
          {
            id: "claude-b",
            display_name: "B",
            owned_by: "anthropic",
            max_input_tokens: 200000,
            max_tokens: 64000,
          },
        ],
        has_more: false,
        last_id: "claude-b",
      },
    ];
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      const body = pages[call++]!;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", "x-cpa-version": "1" },
      });
    });
    const rows = await fetchCliproxyAnthropicModels({
      baseUrl: "http://cpa.example",
      token: "t",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("after_id=claude-a");
    expect(rows.map((r) => r.id)).toEqual(["claude-a", "claude-b"]);
  });

  test("keeps collected rows when a follow-up request fails", async () => {
    let call = 0;
    const warnings: unknown[] = [];
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call > 1) throw new Error("follow-up failed");
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "claude-a",
              display_name: "A",
              owned_by: "anthropic",
            },
          ],
          has_more: true,
          last_id: "claude-a",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json", "x-cpa-version": "1" },
        },
      );
    });

    const rows = await fetchCliproxyAnthropicModels({
      baseUrl: "http://cpa.example",
      token: "t",
      fetchImpl,
      onWarning: (warning) => warnings.push(warning),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(rows.map((row) => row.id)).toEqual(["claude-a"]);
    expect(warnings).toEqual([{ code: "request_failed", page: 2 }]);
  });

  test("continues after a page with only new non-chat ids", async () => {
    const pages = [
      {
        data: [
          {
            id: "gpt-image-2",
            display_name: "GPT Image 2",
            owned_by: "openai",
          },
        ],
        has_more: true,
        last_id: "gpt-image-2",
      },
      {
        data: [
          {
            id: "claude-chat",
            display_name: "Claude Chat",
            owned_by: "anthropic",
          },
        ],
        has_more: false,
        last_id: "claude-chat",
      },
    ];
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      const body = pages[call++]!;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", "x-cpa-version": "1" },
      });
    });

    const rows = await fetchCliproxyAnthropicModels({
      baseUrl: "http://cpa.example",
      token: "t",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(rows.map((row) => row.id)).toEqual(["claude-chat"]);
  });

  test("stops when a page adds no new decoded ids", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "claude-a",
                display_name: "A",
                owned_by: "anthropic",
                max_input_tokens: 1,
                max_tokens: 1,
              },
            ],
            has_more: true,
            last_id: "claude-a",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "x-cpa-version": "1" },
          },
        ),
    );
    const rows = await fetchCliproxyAnthropicModels({
      baseUrl: "http://cpa.example",
      token: "t",
      fetchImpl,
    });
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(CLIPROXY_MODELS_MAX_PAGES);
    expect(rows.map((r) => r.id)).toEqual(["claude-a"]);
  });
});

describe("appendCliproxyModelsToClaudeCatalog", () => {
  const base = [
    {
      provider: "claude" as const,
      id: "claude-fable-5",
      label: "Claude Fable 5",
      contextWindowMaxTokens: 1_000_000,
    },
  ];

  test("overlays CPA windows onto existing catalog ids and appends the rest", async () => {
    const result = await appendCliproxyModelsToClaudeCatalog({
      baseModels: [
        {
          provider: "claude" as const,
          id: "claude-opus-4-8",
          label: "Opus 4.8",
          contextWindowMaxTokens: 200_000,
        },
      ],
      rows: [
        {
          id: "claude-opus-4-8",
          label: "Claude Opus 4.8",
          ownedBy: "anthropic",
          maxInputTokens: 1_000_000,
          maxOutputTokens: 128_000,
          rawListId: "claude-opus-4-8",
        },
        {
          id: "grok-4.5",
          label: "Grok 4.5",
          ownedBy: "xai",
          maxInputTokens: 500_000,
          maxOutputTokens: 65_536,
          rawListId: "claude-fable-5-dd-5.4-korg",
        },
      ],
      existingAdditionalModels: [],
      lookupModelsDev: async () => ({ found: false, query: "unused" }),
      getCustomThinkingOptions: () => [{ id: "max", label: "Max" }],
    });
    expect(result.models.map((m) => m.id)).toEqual(["claude-opus-4-8", "grok-4.5"]);
    const opus = result.models.find((m) => m.id === "claude-opus-4-8")!;
    expect(opus.contextWindowMaxTokens).toBe(1_000_000);
    expect(opus.maxOutputTokens).toBe(128_000);
    expect(opus.needsCapacityConfig).toBeUndefined();
    const grok = result.models.find((m) => m.id === "grok-4.5")!;
    expect(grok.contextWindowMaxTokens).toBe(500_000);
    expect(grok.maxOutputTokens).toBe(65_536);
    expect(result.autoPersist).toEqual([
      {
        id: "claude-opus-4-8",
        contextWindowMaxTokens: 1_000_000,
        maxOutputTokens: 128_000,
      },
      {
        id: "grok-4.5",
        contextWindowMaxTokens: 500_000,
        maxOutputTokens: 65_536,
      },
    ]);
  });

  test("trusts CPA limits for non-official owners", async () => {
    const result = await appendCliproxyModelsToClaudeCatalog({
      baseModels: base,
      rows: [
        {
          id: "qwen3.8-max",
          label: "qwen3.8-max",
          ownedBy: "OpenCodeGo",
          maxInputTokens: 1_000_000,
          maxOutputTokens: 131_072,
          rawListId: "claude-fable-5-dd-xam-8.3newq",
        },
      ],
      existingAdditionalModels: [],
      lookupModelsDev: async () => ({ found: false, query: "unused" }),
      getCustomThinkingOptions: () => [{ id: "max", label: "Max" }],
    });
    const qwen = result.models.find((m) => m.id === "qwen3.8-max")!;
    expect(qwen.contextWindowMaxTokens).toBe(1_000_000);
    expect(qwen.maxOutputTokens).toBe(131_072);
    expect(qwen.needsCapacityConfig).toBeUndefined();
    expect(result.autoPersist).toEqual([
      {
        id: "qwen3.8-max",
        contextWindowMaxTokens: 1_000_000,
        maxOutputTokens: 131_072,
      },
    ]);
  });

  test("uses CPA windows for gateway models such as Space Bunny and MiMo", async () => {
    const result = await appendCliproxyModelsToClaudeCatalog({
      baseModels: base,
      rows: [
        {
          id: "space-bunny-free",
          label: "Space Bunny Free",
          ownedBy: "opencode",
          maxInputTokens: 1_048_576,
          maxOutputTokens: 524_288,
          rawListId: "claude-fable-5-dd-eerf-ynnub-ecaps",
        },
        {
          id: "mimo-v2.6-flash",
          label: "MiMo-V2.6-Flash",
          ownedBy: "opencode",
          maxInputTokens: 1_048_576,
          maxOutputTokens: 131_072,
          rawListId: "claude-fable-5-dd-hsalf-6.2v-omim",
        },
      ],
      existingAdditionalModels: [],
      lookupModelsDev: async () => ({ found: false, query: "unused" }),
      getCustomThinkingOptions: () => [{ id: "max", label: "Max" }],
    });
    expect(result.models.find((model) => model.id === "space-bunny-free")).toMatchObject({
      contextWindowMaxTokens: 1_048_576,
      maxOutputTokens: 524_288,
    });
    expect(result.models.find((model) => model.id === "mimo-v2.6-flash")).toMatchObject({
      contextWindowMaxTokens: 1_048_576,
      maxOutputTokens: 131_072,
    });
    expect(
      result.models.find((model) => model.id === "space-bunny-free")?.needsCapacityConfig,
    ).toBeUndefined();
    expect(result.autoPersist).toEqual([
      {
        id: "space-bunny-free",
        contextWindowMaxTokens: 1_048_576,
        maxOutputTokens: 524_288,
      },
      {
        id: "mimo-v2.6-flash",
        contextWindowMaxTokens: 1_048_576,
        maxOutputTokens: 131_072,
      },
    ]);
  });

  test("marks multi models.dev hits as needsCapacityConfig", async () => {
    const result = await appendCliproxyModelsToClaudeCatalog({
      baseModels: base,
      rows: [
        {
          id: "qwen3.8-max",
          label: "qwen3.8-max",
          ownedBy: "OpenCodeGo",
          rawListId: "x",
        },
      ],
      existingAdditionalModels: [],
      lookupModelsDev: async () => ({
        found: true,
        query: "qwen3.8-max",
        matchedId: "qwen3.8-max",
        providerId: "opencode-go",
        contextWindowMaxTokens: 1_000_000,
        candidates: [
          {
            providerId: "opencode-go",
            matchedId: "qwen3.8-max",
            contextWindowMaxTokens: 1_000_000,
          },
          {
            providerId: "openrouter",
            matchedId: "qwen/qwen3.8-max",
            contextWindowMaxTokens: 1_000_000,
          },
        ],
      }),
      getCustomThinkingOptions: () => [{ id: "max", label: "Max" }],
    });
    const qwen = result.models.find((m) => m.id === "qwen3.8-max")!;
    expect(qwen.needsCapacityConfig).toBe(true);
    expect(qwen.modelsDevCandidates).toHaveLength(2);
    expect(qwen.contextWindowMaxTokens).toBeUndefined();
    expect(result.autoPersist).toEqual([]);
  });

  test("existing additionalModels limits win and clear warning", async () => {
    const result = await appendCliproxyModelsToClaudeCatalog({
      baseModels: base,
      rows: [
        {
          id: "qwen3.8-max",
          label: "qwen3.8-max",
          ownedBy: "OpenCodeGo",
          maxInputTokens: 200_000,
          maxOutputTokens: 64_000,
          rawListId: "x",
        },
      ],
      existingAdditionalModels: [
        { id: "qwen3.8-max", contextWindowMaxTokens: 999_999, maxOutputTokens: 12_345 },
      ],
      lookupModelsDev: async () => ({ found: false, query: "unused" }),
      getCustomThinkingOptions: () => [{ id: "max", label: "Max" }],
    });
    const qwen = result.models.find((m) => m.id === "qwen3.8-max")!;
    expect(qwen.contextWindowMaxTokens).toBe(999_999);
    expect(qwen.maxOutputTokens).toBe(12_345);
    expect(qwen.needsCapacityConfig).toBeUndefined();
    expect(result.autoPersist).toEqual([]);
  });

  test("fills missing output without overwriting configured context", async () => {
    const result = await appendCliproxyModelsToClaudeCatalog({
      baseModels: base,
      rows: [
        {
          id: "grok-4.5",
          label: "Grok 4.5",
          ownedBy: "xai",
          maxInputTokens: 500_000,
          maxOutputTokens: 65_536,
          rawListId: "claude-fable-5-dd-5.4-korg",
        },
      ],
      existingAdditionalModels: [{ id: "grok-4.5", contextWindowMaxTokens: 500_000 }],
      lookupModelsDev: async () => ({ found: false, query: "unused" }),
      getCustomThinkingOptions: () => [{ id: "max", label: "Max" }],
    });

    const grok = result.models.find((model) => model.id === "grok-4.5")!;
    expect(grok.contextWindowMaxTokens).toBe(500_000);
    expect(grok.maxOutputTokens).toBe(65_536);
    expect(grok.needsCapacityConfig).toBeUndefined();
    expect(result.autoPersist).toEqual([{ id: "grok-4.5", maxOutputTokens: 65_536 }]);
  });

  test("preserves a configured model label when auto-filling capacity", async () => {
    const existing = [
      { id: "grok-4.5", label: "My Grok profile", contextWindowMaxTokens: 500_000 },
    ];
    const result = await appendCliproxyModelsToClaudeCatalog({
      baseModels: base,
      rows: [
        {
          id: "grok-4.5",
          label: "Gateway Grok label",
          ownedBy: "xai",
          maxInputTokens: 500_000,
          maxOutputTokens: 65_536,
          rawListId: "claude-fable-5-dd-5.4-korg",
        },
      ],
      existingAdditionalModels: existing,
      lookupModelsDev: async () => ({ found: false, query: "unused" }),
      getCustomThinkingOptions: () => [{ id: "max", label: "Max" }],
    });

    expect(result.autoPersist).toEqual([{ id: "grok-4.5", maxOutputTokens: 65_536 }]);
    expect(mergeAdditionalModelLimits(existing, result.autoPersist)).toEqual([
      {
        id: "grok-4.5",
        label: "My Grok profile",
        contextWindowMaxTokens: 500_000,
        maxOutputTokens: 65_536,
      },
    ]);
  });

  test("fills missing context without overwriting configured output", async () => {
    const result = await appendCliproxyModelsToClaudeCatalog({
      baseModels: base,
      rows: [
        {
          id: "grok-4.5",
          label: "Grok 4.5",
          ownedBy: "xai",
          maxInputTokens: 500_000,
          maxOutputTokens: 65_536,
          rawListId: "claude-fable-5-dd-5.4-korg",
        },
      ],
      existingAdditionalModels: [{ id: "grok-4.5", maxOutputTokens: 65_536 }],
      lookupModelsDev: async () => ({ found: false, query: "unused" }),
      getCustomThinkingOptions: () => [{ id: "max", label: "Max" }],
    });

    const grok = result.models.find((model) => model.id === "grok-4.5")!;
    expect(grok.contextWindowMaxTokens).toBe(500_000);
    expect(grok.maxOutputTokens).toBe(65_536);
    expect(grok.needsCapacityConfig).toBeUndefined();
    expect(result.autoPersist).toEqual([{ id: "grok-4.5", contextWindowMaxTokens: 500_000 }]);
  });

  test("does not overwrite openai subscription windows via models.dev", async () => {
    const lookup = vi.fn(async () => ({
      found: true as const,
      query: "gpt-5.6-sol",
      matchedId: "gpt-5.6-sol",
      providerId: "openai",
      contextWindowMaxTokens: 1_000_000,
      candidates: [],
    }));
    const result = await appendCliproxyModelsToClaudeCatalog({
      baseModels: base,
      rows: [
        {
          id: "gpt-5.6-sol",
          label: "GPT 5.6 Sol",
          ownedBy: "openai",
          maxInputTokens: 372_000,
          maxOutputTokens: 128_000,
          rawListId: "claude-fable-5-dd-los-6.5-tpg",
        },
      ],
      existingAdditionalModels: [],
      lookupModelsDev: lookup,
      getCustomThinkingOptions: () => [{ id: "max", label: "Max" }],
    });
    expect(lookup).toHaveBeenCalled();
    expect(result.models.find((m) => m.id === "gpt-5.6-sol")?.contextWindowMaxTokens).toBe(372_000);
  });

  test("trusts CPA limits when models.dev misses", async () => {
    const result = await appendCliproxyModelsToClaudeCatalog({
      baseModels: base,
      rows: [
        {
          id: "custom-gateway-model",
          label: "Custom Gateway Model",
          ownedBy: "custom-gateway",
          maxInputTokens: 200_000,
          maxOutputTokens: 64_000,
          rawListId: "x",
        },
      ],
      existingAdditionalModels: [],
      lookupModelsDev: async () => ({
        found: false,
        query: "custom-gateway-model",
        error: "models.dev unavailable",
      }),
      getCustomThinkingOptions: () => [{ id: "max", label: "Max" }],
    });
    const model = result.models.find((m) => m.id === "custom-gateway-model")!;
    expect(model.contextWindowMaxTokens).toBe(200_000);
    expect(model.maxOutputTokens).toBe(64_000);
    expect(model.needsCapacityConfig).toBeUndefined();
    expect(result.autoPersist).toEqual([
      {
        id: "custom-gateway-model",
        contextWindowMaxTokens: 200_000,
        maxOutputTokens: 64_000,
      },
    ]);
  });
});

describe("mergeAdditionalModelLimits", () => {
  test("preserves existing user fields and fills only missing limits", () => {
    const existing = [{ id: "configured", label: "My model", contextWindowMaxTokens: 99_999 }];
    const merged = mergeAdditionalModelLimits(existing, [
      {
        id: "configured",
        label: "Gateway label",
        contextWindowMaxTokens: 1_000_000,
        maxOutputTokens: 65_536,
      },
      { id: "new-model", label: "New model", contextWindowMaxTokens: 500_000 },
    ]);

    expect(existing).toEqual([
      { id: "configured", label: "My model", contextWindowMaxTokens: 99_999 },
    ]);
    expect(merged).toEqual([
      {
        id: "configured",
        label: "My model",
        contextWindowMaxTokens: 99_999,
        maxOutputTokens: 65_536,
      },
      { id: "new-model", label: "New model", contextWindowMaxTokens: 500_000 },
    ]);
  });

  test("returns the existing array when every positive limit is already configured", () => {
    const existing = [
      {
        id: "configured",
        label: "My model",
        contextWindowMaxTokens: 99_999,
        maxOutputTokens: 65_536,
      },
    ];

    expect(
      mergeAdditionalModelLimits(existing, [
        {
          id: "configured",
          label: "Gateway label",
          contextWindowMaxTokens: 1_000_000,
          maxOutputTokens: 128_000,
        },
      ]),
    ).toBe(existing);
  });
});
