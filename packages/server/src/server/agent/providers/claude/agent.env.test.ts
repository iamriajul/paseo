import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentLaunchContext } from "../../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { ClaudeAgentClient } from "./agent.js";
import {
  appendCliproxyModelsToClaudeCatalog,
  mergeAdditionalModelLimits,
} from "./cliproxy-models.js";
import type { ClaudeQueryInput } from "./query.js";
import {
  CLAUDE_AUTO_COMPACT_WINDOW_ENV_KEY,
  CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS,
  CLAUDE_MAX_CONTEXT_TOKENS_ENV_KEY,
  CLAUDE_MAX_OUTPUT_TOKENS_ENV_KEY,
} from "./models.js";

function createQueryMock(events: unknown[]): Query {
  let index = 0;
  return {
    next: vi.fn(async () =>
      index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined },
    ),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    applyFlagSettings: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
}

interface SdkUserContentBlock {
  type: string;
  text?: string;
  source?: { data?: string };
}

function isImageBlock(block: SdkUserContentBlock): boolean {
  return block.type === "image";
}

function isNonPromptTextBlock(promptText: string) {
  return (block: SdkUserContentBlock): boolean =>
    block.type === "text" && block.text !== promptText;
}

describe("Claude SDK env", () => {
  beforeEach(() => {
    for (const key of CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
    vi.stubEnv(CLAUDE_MAX_CONTEXT_TOKENS_ENV_KEY, "");
    vi.stubEnv(CLAUDE_MAX_OUTPUT_TOKENS_ENV_KEY, "");
    vi.stubEnv(CLAUDE_AUTO_COMPACT_WINDOW_ENV_KEY, "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("forwards launch-context env through Claude process env", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const launchContext: AgentLaunchContext = {
      env: {
        PASEO_AGENT_ID: "00000000-0000-4000-8000-000000000201",
        PASEO_TEST_FLAG: "launch-value",
      },
    };
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedEnv = options.env;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "managed-agent-env-session",
          permissionMode: "default",
          model: "opus",
        },
        {
          type: "assistant",
          message: { content: "done" },
        },
        {
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
          total_cost_usd: 0,
        },
      ]);
    });

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
      runtimeSettings: {
        env: {
          MCP_TIMEOUT: "claude-startup-timeout",
          MCP_TOOL_TIMEOUT: "claude-tool-timeout",
        },
      },
    });
    const session = await client.createSession(
      {
        provider: "claude",
        cwd: process.cwd(),
      },
      launchContext,
    );

    try {
      const result = await session.run("env check");
      expect(result.sessionId).toBe("managed-agent-env-session");
      expect(capturedEnv?.PASEO_AGENT_ID).toBe(launchContext.env?.PASEO_AGENT_ID);
      expect(capturedEnv?.PASEO_TEST_FLAG).toBe(launchContext.env?.PASEO_TEST_FLAG);
      expect(capturedEnv?.MCP_TIMEOUT).toBe("claude-startup-timeout");
      expect(capturedEnv?.MCP_TOOL_TIMEOUT).toBe("claude-tool-timeout");
    } finally {
      await session.close();
    }
  });

  test("forwards launch-context env through Claude resume env", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const launchContext: AgentLaunchContext = {
      env: {
        PASEO_AGENT_ID: "00000000-0000-4000-8000-000000000202",
        PASEO_TEST_FLAG: "resume-launch-value",
      },
    };
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedEnv = options.env;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "persisted-session",
          permissionMode: "default",
          model: "opus",
        },
        {
          type: "assistant",
          message: { content: "done" },
        },
        {
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
          total_cost_usd: 0,
        },
      ]);
    });

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.resumeSession(
      {
        provider: "claude",
        sessionId: "persisted-session",
        metadata: {
          cwd: process.cwd(),
        },
      },
      {
        cwd: process.cwd(),
      },
      launchContext,
    );

    try {
      const result = await session.run("resume env check");
      expect(result.sessionId).toBe("persisted-session");
      expect(capturedEnv?.PASEO_AGENT_ID).toBe(launchContext.env?.PASEO_AGENT_ID);
      expect(capturedEnv?.PASEO_TEST_FLAG).toBe(launchContext.env?.PASEO_TEST_FLAG);
    } finally {
      await session.close();
    }
  });

  test("pins family and subagent env vars for custom non-family models", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedEnv = options.env;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "custom-model-pin-session",
          permissionMode: "default",
          model: "glm-5.1",
        },
        {
          type: "assistant",
          message: { content: "done" },
        },
        {
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
          total_cost_usd: 0,
        },
      ]);
    });

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "glm-5.1",
    });

    try {
      await session.run("pin check");
      expect(capturedEnv?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.1");
      expect(capturedEnv?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-5.1");
      expect(capturedEnv?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("glm-5.1");
      expect(capturedEnv?.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("glm-5.1");
      expect(capturedEnv?.CLAUDE_CODE_SUBAGENT_MODEL).toBe("glm-5.1");
    } finally {
      await session.close();
    }
  });

  test("sets CLAUDE_CODE_MAX_CONTEXT_TOKENS from profile model context window", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedEnv = options.env;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "custom-model-compact-window-session",
          permissionMode: "default",
          model: "glm-5.1",
        },
        {
          type: "assistant",
          message: { content: "done" },
        },
        {
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
          total_cost_usd: 0,
        },
      ]);
    });

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
      profileModels: [{ id: "glm-5.1", contextWindowMaxTokens: 500_000, maxOutputTokens: 500_000 }],
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "glm-5.1",
    });

    try {
      await session.run("compact window check");
      expect(capturedEnv?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("500000");
      expect(capturedEnv?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("500000");
      expect(capturedEnv?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("450000");
    } finally {
      await session.close();
    }
  });

  test("applies context and output env from profileModels for CPA-discovered custom model", async () => {
    const capturedEnvs: Array<Record<string, string | undefined>> = [];
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedEnvs.push(options.env);
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: `grok-4.5-capacity-session-${capturedEnvs.length}`,
          permissionMode: "default",
          model: "grok-4.5",
        },
        {
          type: "assistant",
          message: { content: "done" },
        },
        {
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
          total_cost_usd: 0,
        },
      ]);
    });

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
      profileModels: [{ id: "grok-4.5", contextWindowMaxTokens: 500_000, maxOutputTokens: 65_536 }],
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "grok-4.5",
    });

    try {
      await session.run("CPA capacity env check");
      expect(capturedEnvs[0]?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("500000");
      expect(capturedEnvs[0]?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("65536");
    } finally {
      await session.close();
    }

    const preSetSession = await client.createSession(
      {
        provider: "claude",
        cwd: process.cwd(),
        model: "grok-4.5",
      },
      {
        env: {
          CLAUDE_CODE_MAX_CONTEXT_TOKENS: "123456",
        },
      },
    );

    try {
      await preSetSession.run("CPA capacity env preservation check");
      // Profile/additional-model capacity wins over ambient CLAUDE_CODE_* so a
      // host 200k (or leftover shell export) cannot keep auto-compact firing early.
      expect(capturedEnvs[1]?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("500000");
      expect(capturedEnvs[1]?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("65536");
    } finally {
      await preSetSession.close();
    }
  });

  test("sets CLAUDE_CODE_AUTO_COMPACT_WINDOW from profile threshold percent", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedEnv = options.env;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "custom-model-compact-percent-session",
          permissionMode: "default",
          model: "glm-5.1",
        },
        {
          type: "assistant",
          message: { content: "done" },
        },
        {
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
          total_cost_usd: 0,
        },
      ]);
    });

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
      profileModels: [
        {
          id: "glm-5.1",
          contextWindowMaxTokens: 500_000,
          autoCompactThresholdPercent: 95,
        },
      ],
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "glm-5.1",
    });

    try {
      await session.run("compact percent check");
      expect(capturedEnv?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("500000");
      expect(capturedEnv?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("475000");
    } finally {
      await session.close();
    }
  });

  test("does not overwrite user-provided Claude model pin env vars", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedEnv = options.env;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "custom-model-user-pin-session",
          permissionMode: "default",
          model: "glm-5.1",
        },
        {
          type: "assistant",
          message: { content: "done" },
        },
        {
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
          total_cost_usd: 0,
        },
      ]);
    });

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession(
      {
        provider: "claude",
        cwd: process.cwd(),
        model: "glm-5.1",
      },
      {
        env: {
          ANTHROPIC_DEFAULT_OPUS_MODEL: "user-opus-pin",
        },
      },
    );

    try {
      await session.run("user pin check");
      expect(capturedEnv?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("user-opus-pin");
      expect(capturedEnv?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-5.1");
      expect(capturedEnv?.CLAUDE_CODE_SUBAGENT_MODEL).toBe("glm-5.1");
    } finally {
      await session.close();
    }
  });

  test("sets CLAUDE_CODE_PROMPT_CACHE_TTL from prompt_cache_ttl feature value", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedEnv = options.env;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "prompt-cache-ttl-session",
          permissionMode: "default",
          model: "opus",
        },
        { type: "assistant", message: { content: "done" } },
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
          total_cost_usd: 0,
        },
      ]);
    });

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      featureValues: { prompt_cache_ttl: "5m" },
    });

    try {
      await session.run("cache ttl check");
      expect(capturedEnv?.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("5m");
    } finally {
      await session.close();
    }
  });

  test("forwards 1h prompt_cache_ttl feature value to the SDK env", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedEnv = options.env;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "prompt-cache-ttl-1h-session",
          permissionMode: "default",
          model: "opus",
        },
        { type: "assistant", message: { content: "done" } },
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
          total_cost_usd: 0,
        },
      ]);
    });

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      featureValues: { prompt_cache_ttl: "1h" },
    });

    try {
      await session.run("cache ttl 1h check");
      expect(capturedEnv?.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("1h");
    } finally {
      await session.close();
    }
  });

  test("leaves CLAUDE_CODE_PROMPT_CACHE_TTL unset for default or missing feature value", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedEnv = options.env;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "prompt-cache-ttl-default-session",
          permissionMode: "default",
          model: "opus",
        },
        { type: "assistant", message: { content: "done" } },
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
          total_cost_usd: 0,
        },
      ]);
    });

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      featureValues: { prompt_cache_ttl: "default" },
    });

    try {
      await session.run("cache ttl default check");
      expect(capturedEnv?.CLAUDE_CODE_PROMPT_CACHE_TTL).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  test("does not overwrite user-provided CLAUDE_CODE_PROMPT_CACHE_TTL from provider env", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedEnv = options.env;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "prompt-cache-ttl-user-env-session",
          permissionMode: "default",
          model: "opus",
        },
        { type: "assistant", message: { content: "done" } },
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
          total_cost_usd: 0,
        },
      ]);
    });

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession(
      {
        provider: "claude",
        cwd: process.cwd(),
        featureValues: { prompt_cache_ttl: "5m" },
      },
      {
        env: {
          CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
        },
      },
    );

    try {
      await session.run("user cache ttl check");
      expect(capturedEnv?.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("1h");
    } finally {
      await session.close();
    }
  });

  test("ignores invalid prompt_cache_ttl feature values", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedEnv = options.env;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "prompt-cache-ttl-invalid-session",
          permissionMode: "default",
          model: "opus",
        },
        { type: "assistant", message: { content: "done" } },
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
          total_cost_usd: 0,
        },
      ]);
    });

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      featureValues: { prompt_cache_ttl: "30m" },
    });

    try {
      await session.run("invalid cache ttl check");
      expect(capturedEnv?.CLAUDE_CODE_PROMPT_CACHE_TTL).toBeUndefined();
    } finally {
      await session.close();
    }
  });
  describe("gateway WebSearch auto-disallow", () => {
    const gateway = { baseUrl: "http://127.0.0.1:8317", apiKey: "test-key" };

    async function captureDisallowedTools(options: {
      model: string;
      baseUrl?: string;
      runtimeDisallowedTools?: string[];
    }): Promise<readonly string[] | undefined> {
      let captured: readonly string[] | undefined;
      const queryFactory = vi.fn(({ options: sdkOptions }: ClaudeQueryInput) => {
        captured = sdkOptions.disallowedTools;
        return createQueryMock([
          {
            type: "system",
            subtype: "init",
            session_id: `websearch-policy-${options.model}-${captured?.length ?? 0}`,
            permissionMode: "default",
            model: options.model,
          },
          { type: "assistant", message: { content: "done" } },
          {
            type: "result",
            subtype: "success",
            usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
            total_cost_usd: 0,
          },
        ]);
      });
      const runtimeSettings: ProviderRuntimeSettings = {
        ...(options.baseUrl ? { env: { ANTHROPIC_BASE_URL: options.baseUrl } } : {}),
        ...(options.runtimeDisallowedTools
          ? { disallowedTools: options.runtimeDisallowedTools }
          : {}),
      };
      const client = new ClaudeAgentClient({
        logger: createTestLogger(),
        queryFactory,
        resolveBinary: async () => "/test/claude/bin",
        gateway,
        runtimeSettings,
      });
      const session = await client.createSession({
        provider: "claude",
        cwd: process.cwd(),
        model: options.model,
      });
      try {
        await session.run("tool policy check");
      } finally {
        await session.close();
      }
      return captured;
    }

    test("disallows WebSearch for gateway-routed custom models", async () => {
      const disallowedTools = await captureDisallowedTools({
        model: "grok-4.5",
        baseUrl: "http://127.0.0.1:8317/v1",
      });
      expect(disallowedTools).toContain("WebSearch");
    });

    test("keeps WebSearch for first-party models on the gateway", async () => {
      const disallowedTools = await captureDisallowedTools({
        model: "claude-opus-5",
        baseUrl: "http://127.0.0.1:8317/v1",
      });
      expect(disallowedTools ?? []).not.toContain("WebSearch");
    });

    test("keeps WebSearch for custom models off the gateway", async () => {
      const disallowedTools = await captureDisallowedTools({
        model: "grok-4.5",
        baseUrl: "https://api.anthropic.com",
      });
      expect(disallowedTools ?? []).not.toContain("WebSearch");
    });

    test("does not duplicate WebSearch when already disallowed", async () => {
      const disallowedTools = await captureDisallowedTools({
        model: "grok-4.5",
        baseUrl: "http://127.0.0.1:8317",
        runtimeDisallowedTools: ["WebSearch"],
      });
      expect(disallowedTools).toEqual(["WebSearch"]);
    });
  });

  test("uses auto-persisted capacity for sessions created before the next rebuild", async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-claude-env-"));
    try {
      await fs.writeFile(path.join(configDir, "settings.json"), "{}");
      vi.stubEnv("ANTHROPIC_BASE_URL", "http://cpa.example");
      vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "test-token");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "claude-fable-5-dd-5.4-korg",
                  display_name: "Grok 4.5",
                  owned_by: "xai",
                  max_input_tokens: 500_000,
                  max_tokens: 65_536,
                },
              ],
              has_more: false,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json", "x-cpa-version": "test" },
            },
          );
        }),
      );
      let capturedEnv: Record<string, string | undefined> | undefined;
      const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
        capturedEnv = options.env;
        return createQueryMock([
          {
            type: "system",
            subtype: "init",
            session_id: "autopersist-capacity-session",
            permissionMode: "default",
            model: "grok-4.5",
          },
          { type: "assistant", message: { content: "done" } },
          {
            type: "result",
            subtype: "success",
            usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
            total_cost_usd: 0,
          },
        ]);
      });
      const persistClaudeAdditionalModelLimits = vi.fn();
      const client = new ClaudeAgentClient({
        logger: createTestLogger(),
        queryFactory,
        resolveBinary: async () => "/test/claude/bin",
        configDir,
        resolveVersion: async () => "2.1.219",
        profileModels: [],
        persistClaudeAdditionalModelLimits,
      });

      await client.fetchCatalog({ scope: "global", force: true });
      expect(persistClaudeAdditionalModelLimits).toHaveBeenCalledWith([
        { id: "grok-4.5", contextWindowMaxTokens: 500_000, maxOutputTokens: 65_536 },
      ]);

      const session = await client.createSession({
        provider: "claude",
        cwd: process.cwd(),
        model: "grok-4.5",
      });
      try {
        await session.run("post-discovery capacity check");
        expect(capturedEnv?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("500000");
        expect(capturedEnv?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("65536");
      } finally {
        await session.close();
      }
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  describe("image input modalities", () => {
    const ONE_BY_ONE_PNG_BASE64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X1r0AAAAASUVORK5CYII=";

    async function captureSdkUserMessage(
      profileModels?: Array<{ id: string; inputModalities?: string[] }>,
    ): Promise<Extract<SDKUserMessage, { type: "user" }>> {
      let capturedPrompt: ClaudeQueryInput["prompt"] | undefined;
      const queryFactory = vi.fn((input: ClaudeQueryInput) => {
        capturedPrompt = input.prompt;
        return createQueryMock([
          {
            type: "system",
            subtype: "init",
            session_id: `image-modality-${profileModels?.[0]?.id ?? "unknown"}-${Date.now()}`,
            permissionMode: "default",
            model: "grok-4.5",
          },
          { type: "assistant", message: { content: "done" } },
          {
            type: "result",
            subtype: "success",
            usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
            total_cost_usd: 0,
          },
        ]);
      });
      const client = new ClaudeAgentClient({
        logger: createTestLogger(),
        queryFactory,
        resolveBinary: async () => "/test/claude/bin",
        ...(profileModels ? { profileModels } : {}),
      });
      const session = await client.createSession({
        provider: "claude",
        cwd: process.cwd(),
        model: "grok-4.5",
      });
      try {
        await session.run([
          { type: "text", text: "describe this image" },
          { type: "image", data: ONE_BY_ONE_PNG_BASE64, mimeType: "image/png" },
        ]);
      } finally {
        await session.close();
      }
      const iterator = (
        capturedPrompt as unknown as AsyncIterable<Extract<SDKUserMessage, { type: "user" }>>
      )[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (!first.value) throw new Error("expected the prompt to reach the SDK input");
      return first.value;
    }

    test("sends a file hint when the model is known text-only", async () => {
      const message = await captureSdkUserMessage([{ id: "grok-4.5", inputModalities: ["text"] }]);
      const content = message.message.content;
      expect(Array.isArray(content)).toBe(true);
      const blocks = content as SdkUserContentBlock[];
      expect(blocks.some(isImageBlock)).toBe(false);
      const hint = blocks.find(isNonPromptTextBlock("describe this image"));
      expect(hint?.text).toMatch(/^\[Image available at: .*\.png\]$/);
    });

    test("forwards images when the model supports image input", async () => {
      const message = await captureSdkUserMessage([
        { id: "grok-4.5", inputModalities: ["text", "image"] },
      ]);
      const blocks = message.message.content as SdkUserContentBlock[];
      const image = blocks.find(isImageBlock);
      expect(image?.source?.data).toBe(ONE_BY_ONE_PNG_BASE64);
    });

    test("forwards images when modalities are unknown", async () => {
      const message = await captureSdkUserMessage();
      const blocks = message.message.content as SdkUserContentBlock[];
      const image = blocks.find(isImageBlock);
      expect(image?.source?.data).toBe(ONE_BY_ONE_PNG_BASE64);
    });
  });

  describe("cliproxy modalities auto-persist", () => {
    test("persists modalities from a single models.dev hit", async () => {
      const result = await appendCliproxyModelsToClaudeCatalog({
        baseModels: [],
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
        existingAdditionalModels: [],
        lookupModelsDev: async () => ({
          found: true,
          query: "qwen3.8-max",
          matchedId: "qwen3.8-max",
          providerId: "opencode-go",
          contextWindowMaxTokens: 1_000_000,
          maxOutputTokens: 131_072,
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
          capabilities: ["tool_call"],
          candidates: [
            {
              providerId: "opencode-go",
              matchedId: "qwen3.8-max",
              contextWindowMaxTokens: 1_000_000,
              maxOutputTokens: 131_072,
              inputModalities: ["text", "image"],
              outputModalities: ["text"],
              capabilities: ["tool_call"],
            },
          ],
        }),
        getCustomThinkingOptions: () => [],
      });
      expect(result.autoPersist).toEqual([
        {
          id: "qwen3.8-max",
          contextWindowMaxTokens: 1_000_000,
          maxOutputTokens: 131_072,
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
          capabilities: ["tool_call"],
        },
      ]);
    });

    test("merge fills missing modalities without overwriting configured ones", () => {
      const existing = [
        {
          id: "configured",
          contextWindowMaxTokens: 99_999,
          inputModalities: ["text"],
        },
      ];
      const merged = mergeAdditionalModelLimits(existing, [
        {
          id: "configured",
          contextWindowMaxTokens: 1_000_000,
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
        },
        { id: "new-model", inputModalities: ["text"] },
      ]);
      expect(merged).toEqual([
        {
          id: "configured",
          contextWindowMaxTokens: 99_999,
          inputModalities: ["text"],
          outputModalities: ["text"],
        },
        { id: "new-model", inputModalities: ["text"] },
      ]);
    });
  });
});
