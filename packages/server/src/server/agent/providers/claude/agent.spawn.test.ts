import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type {
  Options,
  Query,
  SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import * as spawnUtils from "../../../../utils/spawn.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeQuery, type ClaudeOptions, type ClaudeQueryInput } from "./query.js";

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

function createChildProcessStub(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  return child;
}

describe("Claude spawn override", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("bypasses the shell when spawning Claude Code", async () => {
    let capturedOptions: Options | undefined;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedOptions = options;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "claude-spawn-shell-regression-session",
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
    const spawnSpy = vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(createChildProcessStub());
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    try {
      await session.run("spawn shell regression");
      capturedOptions?.spawnClaudeCodeProcess?.({
        command: "node",
        args: ["claude.js", "--mcp-config", '{"mcpServers":{"paseo":{"type":"http"}}}'],
        cwd: process.cwd(),
        env: {},
        signal: new AbortController().signal,
      } satisfies ClaudeSpawnOptions);
    } finally {
      await session.close();
    }

    const claudeSpawnCall = spawnSpy.mock.calls.find(([, args]) => args[0] === "claude.js");
    expect(claudeSpawnCall).toBeDefined();
    const spawnOptions = claudeSpawnCall?.[2];
    expect(spawnOptions?.shell).toBe(false);
  });
});

describe("Gateway Claude spawn routing", () => {
  const gateway = {
    baseUrl: "http://127.0.0.1:8317",
    apiKey: "test-gateway-key",
  };
  const advertisedIds = new Set(["advertised-model"]);

  async function captureChildEnvFromSession(options: {
    model: string;
    launchEnv?: Record<string, string>;
    command?: string;
  }): Promise<Record<string, string>> {
    let capturedOptions: Options | undefined;
    const queryFactory = vi.fn(({ options: sdkOptions }: ClaudeQueryInput) => {
      capturedOptions = sdkOptions;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: `gateway-spawn-${options.model}`,
          permissionMode: "default",
          model: options.model,
        },
        {
          type: "assistant",
          message: { content: "done" },
        },
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
      gateway,
      cliproxyapiAdvertisedIds: advertisedIds,
      runtimeSettings: {
        env: {
          ANTHROPIC_BASE_URL: gateway.baseUrl,
          ANTHROPIC_AUTH_TOKEN: gateway.apiKey,
        },
      },
    });

    const session = await client.createSession(
      {
        provider: "claude",
        cwd: process.cwd(),
        model: options.model,
      },
      options.launchEnv ? { env: options.launchEnv } : undefined,
    );

    try {
      await session.run("spawn check");
      if (!capturedOptions?.spawnClaudeCodeProcess) {
        throw new Error("spawnClaudeCodeProcess was not provided");
      }
      const command = options.command ?? "/usr/bin/env";
      const isNode = command === "node";
      const args = isNode ? ["-e", "console.log(JSON.stringify(process.env))"] : [];

      const child = capturedOptions.spawnClaudeCodeProcess({
        command,
        args,
        cwd: process.cwd(),
        env: capturedOptions.env ?? {},
        signal: new AbortController().signal,
      });

      const stdoutChunks: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      await new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", () => resolve());
      });
      const output = Buffer.concat(stdoutChunks).toString("utf8");
      if (isNode) {
        return JSON.parse(output.trim());
      }
      const env: Record<string, string> = {};
      for (const line of output.split("\n")) {
        const idx = line.indexOf("=");
        if (idx > 0) {
          env[line.slice(0, idx)] = line.slice(idx + 1);
        }
      }
      return env;
    } finally {
      await session.close();
    }
  }

  test("non-advertised model does not receive gateway ANTHROPIC_BASE_URL or ANTHROPIC_AUTH_TOKEN in spawned child", async () => {
    const childEnv = await captureChildEnvFromSession({ model: "claude-opus-5-5" });
    expect(childEnv.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(childEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test("advertised model receives gateway ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN in spawned child", async () => {
    const childEnv = await captureChildEnvFromSession({ model: "advertised-model" });
    expect(childEnv.ANTHROPIC_BASE_URL).toBe(gateway.baseUrl);
    expect(childEnv.ANTHROPIC_AUTH_TOKEN).toBe(gateway.apiKey);
  });

  test("user non-Gateway ANTHROPIC_BASE_URL is never stripped for non-advertised model", async () => {
    const customUrl = "https://custom.anthropic.endpoint";
    const childEnv = await captureChildEnvFromSession({
      model: "claude-opus-5-5",
      launchEnv: { ANTHROPIC_BASE_URL: customUrl },
    });
    expect(childEnv.ANTHROPIC_BASE_URL).toBe(customUrl);
    expect(childEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test("default node runtime spawn strips gateway env for non-advertised model", async () => {
    const childEnv = await captureChildEnvFromSession({
      model: "claude-opus-5-5",
      command: "node",
    });
    expect(childEnv.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(childEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test("default node runtime spawn preserves gateway env for advertised model", async () => {
    const childEnv = await captureChildEnvFromSession({
      model: "advertised-model",
      command: "node",
    });
    expect(childEnv.ANTHROPIC_BASE_URL).toBe(gateway.baseUrl);
    expect(childEnv.ANTHROPIC_AUTH_TOKEN).toBe(gateway.apiKey);
  });

  describe("direct claudeQuery spawn routing", () => {
    async function captureChildEnvFromClaudeQuery(options: {
      model?: string;
      spawnEnv?: Record<string, string>;
      runtimeSettingsEnv?: Record<string, string>;
      command?: string;
    }): Promise<Record<string, string>> {
      let capturedOptions: ClaudeOptions | undefined;
      claudeQuery(
        {
          prompt: (async function* () {})(),
          options: {
            model: options.model,
            env: options.spawnEnv ?? {},
          },
        },
        {
          gateway,
          cliproxyapiAdvertisedIds: advertisedIds,
          runtimeSettings: {
            env: {
              ANTHROPIC_BASE_URL: gateway.baseUrl,
              ANTHROPIC_AUTH_TOKEN: gateway.apiKey,
              ...options.runtimeSettingsEnv,
            },
          },
          queryFactory: (input) => {
            capturedOptions = input.options;
            return createQueryMock([]);
          },
        },
      );

      if (!capturedOptions?.spawnClaudeCodeProcess) {
        throw new Error("spawnClaudeCodeProcess was not provided");
      }
      const command = options.command ?? "/usr/bin/env";
      const isNode = command === "node";
      const args = isNode ? ["-e", "console.log(JSON.stringify(process.env))"] : [];
      const child = capturedOptions.spawnClaudeCodeProcess({
        command,
        args,
        cwd: process.cwd(),
        env: capturedOptions.env ?? {},
        signal: new AbortController().signal,
      });

      const stdoutChunks: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      await new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", () => resolve());
      });
      const output = Buffer.concat(stdoutChunks).toString("utf8");
      if (isNode) {
        return JSON.parse(output.trim());
      }
      const env: Record<string, string> = {};
      for (const line of output.split("\n")) {
        const idx = line.indexOf("=");
        if (idx > 0) {
          env[line.slice(0, idx)] = line.slice(idx + 1);
        }
      }
      return env;
    }

    test("direct claudeQuery strips gateway env for non-advertised model", async () => {
      const childEnv = await captureChildEnvFromClaudeQuery({ model: "claude-opus-5-5" });
      expect(childEnv.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(childEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    });

    test("direct claudeQuery retains gateway env for advertised model", async () => {
      const childEnv = await captureChildEnvFromClaudeQuery({ model: "advertised-model" });
      expect(childEnv.ANTHROPIC_BASE_URL).toBe(gateway.baseUrl);
      expect(childEnv.ANTHROPIC_AUTH_TOKEN).toBe(gateway.apiKey);
    });

    test("direct claudeQuery never strips user non-Gateway ANTHROPIC_BASE_URL", async () => {
      const customUrl = "https://custom.anthropic.endpoint";
      const childEnv = await captureChildEnvFromClaudeQuery({
        model: "claude-opus-5-5",
        spawnEnv: { ANTHROPIC_BASE_URL: customUrl },
      });
      expect(childEnv.ANTHROPIC_BASE_URL).toBe(customUrl);
      expect(childEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    });
  });
});
