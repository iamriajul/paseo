import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { ProcessEnvRecord } from "../../../paseo-env.js";
import type { ResolvedGatewayConfig } from "../../gateway/config.js";
import * as spawnUtils from "../../../../utils/spawn.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";
import { CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS } from "./models.js";

const GATEWAY: ResolvedGatewayConfig = {
  baseUrl: "http://127.0.0.1:8317",
  apiKey: "gateway-key",
};

const ANTHROPIC_ROUTING_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
] as const;

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

/**
 * Stands in for the Claude Code child process. A real child dies when it is
 * signalled; without that the teardown path waits out its full graceful and
 * force timeout on every test.
 */
function createChildProcessStub(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  child.stdin = new EventEmitter() as ChildProcess["stdin"];
  child.kill = (() => {
    child.emit("exit", 0, null);
    return true;
  }) as ChildProcess["kill"];
  return child;
}

let workDir: string;
let configDir: string;
let savedRoutingEnv: Array<[string, string | undefined]>;

beforeEach(async () => {
  for (const key of CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS) {
    vi.stubEnv(key, "");
  }
  // The daemon's own shell must not carry Anthropic routing, or process.env
  // re-injects it as the base of every child env regardless of routing. Delete
  // rather than blank: an empty value is still a value the child would see.
  savedRoutingEnv = ANTHROPIC_ROUTING_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of ANTHROPIC_ROUTING_KEYS) {
    delete process.env[key];
  }
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-claude-gateway-spawn-"));
  configDir = path.join(workDir, "claude-config");
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, "settings.json"), "{}", "utf8");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [key, value] of savedRoutingEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await fs.rm(workDir, { recursive: true, force: true });
});

interface SpawnEnvOptions {
  model: string;
  /** The `runtimeSettings.env` a Gateway-routed claude provider receives. */
  providerEnv: ProcessEnvRecord;
  gateway?: ResolvedGatewayConfig;
  /** Ids the Gateway lists, as `/v1/models` returned them. */
  advertisedIds?: string[];
}

/**
 * Runs the SDK's real `spawnClaudeCodeProcess` and returns the env the child
 * process was actually spawned with.
 *
 * `query.ts` rebuilds the child env from `runtimeSettings` after `agent.ts`
 * `buildSdkEnv()` strips it, so only the spawn call itself proves which layer
 * won. `spawnProcess` is the single point both spawn paths converge on: the
 * env it receives is the env the OS hands to the child.
 */
async function readSpawnedEnv(
  options: SpawnEnvOptions,
): Promise<Record<string, string | undefined>> {
  let spawned: Record<string, string | undefined> | undefined;
  vi.spyOn(spawnUtils, "spawnProcess").mockImplementation(((
    _command: string,
    _args: string[],
    spawnOptions: Record<string, unknown>,
  ) => {
    spawned = spawnOptions.env as Record<string, string | undefined>;
    return createChildProcessStub();
  }) as unknown as typeof spawnUtils.spawnProcess);

  let capturedOptions: Options | undefined;
  const queryFactory = vi.fn((input: ClaudeQueryInput) => {
    capturedOptions = input.options;
    return createQueryMock([
      {
        type: "system",
        subtype: "init",
        session_id: `gateway-spawn-${options.model}`,
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

  if (options.advertisedIds) {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: options.advertisedIds?.map((id) => ({ id, owned_by: "anthropic" })) ?? [],
              has_more: false,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
  }

  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    // process.execPath keeps the spawn on query.ts's default-runtime path, so
    // production and the test take the same branch.
    resolveBinary: async () => process.execPath,
    resolveVersion: async () => "2.1.280",
    configDir,
    runtimeSettings: { env: options.providerEnv },
    ...(options.gateway ? { gateway: options.gateway } : {}),
  });

  // Discovery is what fills cliproxyapiAdvertisedIds; the routing decision
  // under test is made against it.
  if (options.advertisedIds) {
    await client.fetchCatalog({ scope: "global", force: true });
  }

  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
    model: options.model,
  });

  try {
    await session.run("gateway routing check");
    capturedOptions?.spawnClaudeCodeProcess?.({
      command: "node",
      args: [path.join(workDir, "echo-env.mjs")],
      cwd: process.cwd(),
      env: {},
      signal: new AbortController().signal,
    });
    if (!spawned) {
      throw new Error("expected the SDK to spawn the Claude Code child");
    }
    return spawned;
  } finally {
    await session.close();
  }
}

const GATEWAY_PROVIDER_ENV = {
  ANTHROPIC_BASE_URL: GATEWAY.baseUrl,
  ANTHROPIC_AUTH_TOKEN: GATEWAY.apiKey,
};

describe("Claude Gateway routing at spawn", () => {
  test("a model the Gateway did not advertise launches with no Gateway env", async () => {
    const env = await readSpawnedEnv({
      model: "claude-opus-5-5",
      providerEnv: GATEWAY_PROVIDER_ENV,
      gateway: GATEWAY,
      advertisedIds: ["claude-sonnet-5"],
    });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test("a model the Gateway advertised launches with Gateway env", async () => {
    const env = await readSpawnedEnv({
      model: "claude-opus-4-8",
      providerEnv: GATEWAY_PROVIDER_ENV,
      gateway: GATEWAY,
      advertisedIds: ["claude-opus-4-8"],
    });
    expect(env.ANTHROPIC_BASE_URL).toBe(GATEWAY.baseUrl);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(GATEWAY.apiKey);
  });

  test("daemon-env Gateway routing does not leak into a non-advertised model", async () => {
    // A daemon started with the Gateway in its own shell env (launchd/systemd
    // unit, or `ANTHROPIC_BASE_URL=… paseo daemon`) re-seeds every child from
    // process.env, so a delete on the overlay is not enough.
    process.env.ANTHROPIC_BASE_URL = GATEWAY.baseUrl;
    process.env.ANTHROPIC_AUTH_TOKEN = GATEWAY.apiKey;
    const env = await readSpawnedEnv({
      model: "claude-opus-5-5",
      providerEnv: GATEWAY_PROVIDER_ENV,
      gateway: GATEWAY,
      advertisedIds: ["claude-sonnet-5"],
    });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test("a user's own ANTHROPIC_BASE_URL is never stripped", async () => {
    const userBaseUrl = "https://api.anthropic.com";
    const env = await readSpawnedEnv({
      model: "claude-opus-5-5",
      providerEnv: { ANTHROPIC_BASE_URL: userBaseUrl },
      gateway: GATEWAY,
      advertisedIds: ["claude-sonnet-5"],
    });
    expect(env.ANTHROPIC_BASE_URL).toBe(userBaseUrl);
  });
});
