import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentLaunchContext } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
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
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
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
});
