import { type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { query, type Options, type Query, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import {
  createProviderEnvFromSpec,
  createProviderEnvSpec,
  type ProviderEnvSpec,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { gatewayBaseUrlsMatch, type ResolvedGatewayConfig } from "../../gateway/config.js";
import { buildSelfNodeCommand, type ProcessEnvRecord } from "../../../paseo-env.js";
import { spawnProcess } from "../../../../utils/spawn.js";

// Keep the raw SDK query import in this module only. Claude process launch behavior
// must stay shared between production and tests so Windows .cmd/.bat handling cannot
// diverge from the daemon path.

export type ClaudeOptions = Options;
export type ClaudeQueryInput = Parameters<typeof query>[0] & { options: ClaudeOptions };
export type ClaudeQueryFactory = (input: ClaudeQueryInput) => Query;

export interface ClaudeQueryContext {
  runtimeSettings?: ProviderRuntimeSettings;
  launchEnv?: Record<string, string>;
  /**
   * First-party Gateway routing this session resolved to. Absent means the
   * provider is not Gateway-routed and its env must be left alone.
   */
  gateway?: ResolvedGatewayConfig;
  /**
   * Whether the Gateway advertised this session's model. A model the Gateway
   * did not list keeps the local Claude Code login, so the routing env has to
   * be stripped from the spec this module actually spawns with — the registry
   * merged it into `runtimeSettings` for the whole provider.
   */
  routeThroughGateway?: boolean;
  queryFactory?: ClaudeQueryFactory;
  /** Called with the spawned child process so the caller can tree-kill it on close. */
  onChildProcess?: (child: ChildProcess) => void;
}

/**
 * Drop Gateway `ANTHROPIC_*` routing, leaving any other Anthropic endpoint the
 * user configured. Only values that match this Gateway are removed.
 *
 * Keys are set to `undefined` rather than deleted: the spawn path assigns this
 * onto an env seeded from `process.env`, where a missing key would let the
 * daemon's own Gateway routing back in.
 */
export function stripCliproxyapiRoutingEnv(
  env: ProcessEnvRecord,
  gateway: ResolvedGatewayConfig | undefined,
): ProcessEnvRecord {
  if (!gateway) return env;
  const next: ProcessEnvRecord = { ...env };
  if (gatewayBaseUrlsMatch(next.ANTHROPIC_BASE_URL, gateway.baseUrl)) {
    next.ANTHROPIC_BASE_URL = undefined;
  }
  if (next.ANTHROPIC_AUTH_TOKEN === gateway.apiKey) {
    next.ANTHROPIC_AUTH_TOKEN = undefined;
  }
  return next;
}

/** True when this session's model keeps the local login, not the Gateway's. */
function shouldStripGatewayRouting(context: ClaudeQueryContext): boolean {
  return context.gateway !== undefined && context.routeThroughGateway === false;
}

function applyGatewayRoutingToSpec(
  spec: ProviderEnvSpec,
  context: ClaudeQueryContext,
): ProviderEnvSpec {
  if (!shouldStripGatewayRouting(context)) return spec;
  return { ...spec, envOverlay: stripCliproxyapiRoutingEnv(spec.envOverlay, context.gateway) };
}

function isChildProcessWithStreams(child: ChildProcess): child is ChildProcessWithoutNullStreams {
  return child.stdin !== null && child.stdout !== null && child.stderr !== null;
}

function resolveClaudeSpawnCommand(
  spawnOptions: SpawnOptions,
  runtimeSettings?: ProviderRuntimeSettings,
): { command: string; args: string[] } {
  const commandConfig = runtimeSettings?.command;
  if (!commandConfig || commandConfig.mode === "default") {
    return {
      command: spawnOptions.command,
      args: [...spawnOptions.args],
    };
  }

  if (commandConfig.mode === "append") {
    return {
      command: spawnOptions.command,
      args: [...spawnOptions.args, ...(commandConfig.args ?? [])],
    };
  }

  return {
    command: commandConfig.argv[0],
    args: [...commandConfig.argv.slice(1), ...spawnOptions.args],
  };
}

function applyRuntimeSettingsToClaudeOptions(
  options: ClaudeOptions,
  context: ClaudeQueryContext,
): ClaudeOptions {
  const { runtimeSettings, launchEnv, onChildProcess } = context;
  return {
    ...options,
    spawnClaudeCodeProcess: (spawnOptions) => {
      const resolved = resolveClaudeSpawnCommand(spawnOptions, runtimeSettings);
      // When the SDK passes a default JS runtime ("node"/"bun"), replace it with
      // process.execPath — the actual node binary running the daemon. This avoids
      // PATH lookup failures in the managed runtime bundle.
      // When the SDK passes a native binary path (from pathToClaudeCodeExecutable)
      // or the user overrides the command via runtime settings, use that directly.
      const isDefaultRuntime = resolved.command === "node" || resolved.command === "bun";
      const providerEnvSpec = applyGatewayRoutingToSpec(
        createProviderEnvSpec({
          baseEnv: spawnOptions.env,
          runtimeSettings,
          overlays: [launchEnv],
        }),
        context,
      );
      const providerEnv = createProviderEnvFromSpec(providerEnvSpec);
      // The default-runtime path seeds the child from `process.env`, so a daemon
      // launched against the Gateway would route a model the Gateway never
      // advertised. Strip that seed as well as the overlay assigned over it.
      const stripSeed = shouldStripGatewayRouting(context);
      const routedEnv = stripSeed
        ? stripCliproxyapiRoutingEnv(providerEnv, context.gateway)
        : providerEnv;
      const selfNodeCommand = isDefaultRuntime
        ? buildSelfNodeCommand(
            resolved.args,
            routedEnv,
            stripSeed ? stripCliproxyapiRoutingEnv(process.env, context.gateway) : process.env,
          )
        : null;
      const command = selfNodeCommand?.command ?? resolved.command;
      const args = selfNodeCommand?.args ?? resolved.args;
      const child = spawnProcess(command, args, {
        cwd: spawnOptions.cwd,
        ...(selfNodeCommand
          ? { env: selfNodeCommand.env, envMode: "internal" as const }
          : providerEnvSpec),
        signal: spawnOptions.signal,
        stdio: ["pipe", "pipe", "pipe"],
        // Bypass cmd.exe on Windows: the SDK passes --mcp-config with inline JSON
        // containing double quotes, which cmd.exe mangles (strips quotes, breaks parsing).
        // The command is always a resolved binary path, so shell routing is unnecessary.
        shell: false,
      });
      onChildProcess?.(child);
      if (typeof options.stderr === "function") {
        child.stderr?.on("data", (chunk: Buffer | string) => {
          options.stderr?.(chunk.toString());
        });
      }
      if (!isChildProcessWithStreams(child)) {
        throw new Error("Claude process was spawned without stdio streams");
      }
      return child;
    },
  };
}

export function claudeQuery(input: ClaudeQueryInput, context: ClaudeQueryContext = {}): Query {
  const launchQuery = context.queryFactory ?? query;
  return launchQuery({
    ...input,
    options: applyRuntimeSettingsToClaudeOptions(input.options, context),
  });
}
