import {
  GATEWAY_PROVIDER_ID,
  claudeGatewayEnv,
  codexGatewayEnv,
  ompGatewayEnv,
  type ResolvedGatewayConfig,
} from "../server/agent/gateway/config.js";

/**
 * Harness shims for terminal tabs.
 *
 * Terminal tabs launch harnesses as ordinary child processes, so nothing in
 * Paseo's agent path is there to inject gateway routing. Env alone cannot
 * cover Codex (its `model_providers` map is argv-only) and would leak three
 * gateway credentials into every unrelated process in the shell. A shim in
 * terminal PATH scopes the injection to the harness invocation.
 *
 * These shims are terminal-only. The agent path already injects gateway env
 * through `provider-registry`, and a shim there would double-inject.
 */

/** Per-invocation opt-out: run the real binary with nothing injected. */
export const CLIPROXYAPI_SHIM_DISABLE_ENV = "PASEO_CLIPROXYAPI_DISABLE_SHIM";

/**
 * Harnesses that get a shim.
 *
 * OMP is absent on purpose: it reads `LITELLM_BASE_URL`/`LITELLM_API_KEY`
 * directly, so env alone is sufficient, and those vars are inert without OMP
 * installed. The other three are shimmed together so terminal behavior does
 * not diverge by which binary the user happens to type.
 */
export const SHIMMED_HARNESSES = ["claude", "codex", "opencode"] as const;
export type ShimmedHarness = (typeof SHIMMED_HARNESSES)[number];

export function isShimmedHarness(value: string): value is ShimmedHarness {
  return (SHIMMED_HARNESSES as readonly string[]).includes(value);
}

export interface HarnessShimEnv {
  /** Env the shim sets for the real binary. */
  readonly env: Record<string, string>;
  /** Argv the shim prepends ahead of the user's own arguments. */
  readonly argv: readonly string[];
}

function codexProviderArgs(gateway: ResolvedGatewayConfig): string[] {
  // Reuse the agent path's normalization instead of re-deriving it; a config
  // built without `resolveGatewayConfig` still arrives with a /v1 suffix.
  const baseUrl = codexGatewayEnv(gateway).OPENAI_BASE_URL;
  return [
    "-c",
    `model_providers.${GATEWAY_PROVIDER_ID}.name="CLIProxyAPI"`,
    "-c",
    `model_providers.${GATEWAY_PROVIDER_ID}.base_url="${baseUrl}"`,
    "-c",
    `model_providers.${GATEWAY_PROVIDER_ID}.env_key="OPENAI_API_KEY"`,
    "-c",
    `model_providers.${GATEWAY_PROVIDER_ID}.requires_openai_auth=false`,
    // Codex 0.159 dropped `wire_api = "chat"`; the agent path already pins
    // "responses" in codex-app-server-agent.ts and this must match it.
    "-c",
    `model_providers.${GATEWAY_PROVIDER_ID}.wire_api="responses"`,
    // Without this header CLIProxyAPI drops ChatGPT-parity tool calls
    // (including image generation) instead of routing them.
    "-c",
    `model_providers.${GATEWAY_PROVIDER_ID}.http_headers={"X-OpenAI-Actor-Authorization"="local-proxy"}`,
  ];
}

function openCodeConfigContent(gateway: ResolvedGatewayConfig): string {
  // Same normalization as the Codex argv above, for the same reason.
  const baseUrl = codexGatewayEnv(gateway).OPENAI_BASE_URL;
  return JSON.stringify({
    provider: {
      [GATEWAY_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "CLIProxyAPI",
        options: {
          baseURL: baseUrl,
          apiKey: gateway.apiKey,
        },
        models: {},
      },
    },
  });
}

/**
 * The env and argv a harness shim applies to the real binary.
 *
 * OpenCode's models map is left empty: the gateway's live catalog is fetched by
 * the agent path, and an empty map here would make the provider register with
 * no selectable models. Populate it only once discovery can run at shim time.
 */
export function buildHarnessShimEnv(
  harness: ShimmedHarness,
  gateway: ResolvedGatewayConfig,
): HarnessShimEnv {
  switch (harness) {
    case "claude":
      return {
        env: {
          ...claudeGatewayEnv(gateway),
          // Reads /v1/models at [Bootstrap] so the TUI model picker lists
          // gateway slugs. Undocumented internal flag, not a public contract.
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        },
        argv: [],
      };
    case "codex":
      return {
        env: codexGatewayEnv(gateway),
        argv: codexProviderArgs(gateway),
      };
    case "opencode":
      return {
        env: {
          OPENCODE_CONFIG_CONTENT: openCodeConfigContent(gateway),
        },
        argv: [],
      };
  }
}

/** Env for harnesses routed without a shim. OMP reads these directly. */
export function terminalHarnessGatewayEnv(gateway: ResolvedGatewayConfig): Record<string, string> {
  return ompGatewayEnv(gateway);
}
