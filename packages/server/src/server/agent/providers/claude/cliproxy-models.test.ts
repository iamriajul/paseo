import { describe, expect, test, vi } from "vitest";
import {
  CLIPROXY_MODELS_MAX_PAGES,
  decodeCliproxyClaudeModelId,
  fetchCliproxyAnthropicModels,
  isOfficialCpaOwner,
  isCliproxyNonChatModel,
  resolveCliproxyAnthropicCredentials,
} from "./cliproxy-models.js";

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
  test("returns empty when response lacks X-CPA fingerprint", async () => {
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
    });
    expect(rows).toEqual([]);
  });

  test("loads single page when has_more is false", async () => {
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
        ),
    );
    const rows = await fetchCliproxyAnthropicModels({
      baseUrl: "http://cpa.example",
      token: "t",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
