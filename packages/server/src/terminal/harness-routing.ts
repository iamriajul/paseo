import { ensureHarnessShims } from "./harness-shim-writer.js";
import { terminalHarnessGatewayEnv } from "./harness-shims.js";
import type { ResolvedGatewayConfig } from "../server/agent/gateway/config.js";

/**
 * Gateway routing for terminal tabs.
 *
 * Terminal tabs launch harnesses as ordinary child processes, so nothing in
 * Paseo's agent path is there to inject gateway routing. Two shapes are needed
 * because the harnesses disagree on how they accept a custom endpoint: Codex
 * only takes its `model_providers` map from argv, so it gets a shim; OMP reads
 * `LITELLM_*` from its own process env, so env alone is enough.
 */

export interface TerminalGatewayRoutingInput {
  paseoHome: string;
  /** Resolved CLIProxyAPI config, or null when the gateway is not configured. */
  gateway: ResolvedGatewayConfig | null | undefined;
}

export interface TerminalGatewayRouting {
  /** The shim directory, or null when no gateway produced shims. */
  shimDirectory: string | null;
  /**
   * Env the shimmed harnesses do not cover, to apply *under* the caller's env.
   *
   * `registerCwdEnv` and per-create `env` must keep winning: a workspace that
   * already routes its own terminals must not be silently rerouted.
   */
  env: Record<string, string>;
}

/**
 * Rewrite the harness shims and report what the terminal env needs.
 *
 * Rewriting here rather than at daemon start means a gateway edit reaches new
 * terminals without a restart, and the shims stay private to their per-daemon
 * directory.
 */
export function buildTerminalGatewayRouting(
  input: TerminalGatewayRoutingInput,
): TerminalGatewayRouting {
  const shimDirectory = ensureHarnessShims(input.paseoHome, input.gateway);
  if (!shimDirectory || !input.gateway) {
    return { shimDirectory: null, env: {} };
  }

  // OMP needs no shim, so its vars are set directly. They are inert without OMP
  // installed, which is the same trade the agent path already makes.
  return { shimDirectory, env: terminalHarnessGatewayEnv(input.gateway) };
}
