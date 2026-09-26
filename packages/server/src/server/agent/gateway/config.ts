import { z } from "zod";

/**
 * First-party CLIProxyAPI configuration (`agents.cliproxyapi` in config.json).
 * One routing shared by the base claude/codex/opencode/omp providers.
 * Derived providers that set their own routing/auth env are never touched.
 */
export const GatewayConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
  })
  .strict();

export type GatewayPersistedConfig = z.infer<typeof GatewayConfigSchema>;

export interface ResolvedGatewayConfig {
  baseUrl: string;
  apiKey: string;
}

export const CLIPROXYAPI_ENV_BASE_URL = "PASEO_CLIPROXYAPI_BASE_URL";
export const CLIPROXYAPI_ENV_API_KEY = "PASEO_CLIPROXYAPI_API_KEY";
/** COMPAT(agents.gateway): renamed to cliproxyapi. Still read. */
export const GATEWAY_ENV_BASE_URL = "PASEO_GATEWAY_BASE_URL";
export const GATEWAY_ENV_API_KEY = "PASEO_GATEWAY_API_KEY";

/** Provider id used for CLIProxyAPI-routed models in Codex thread config and OpenCode. */
export const GATEWAY_PROVIDER_ID = "cliproxyapi";

function trimNonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Resolve CLIProxyAPI routing. `PASEO_CLIPROXYAPI_*` wins over
 * `PASEO_GATEWAY_*`, and either env wins over config.json. Either pair
 * enables routing. Both base URL and key are required.
 */
export function resolveGatewayConfig(
  persisted?: GatewayPersistedConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedGatewayConfig | null {
  const envBaseUrl =
    trimNonEmpty(env[CLIPROXYAPI_ENV_BASE_URL]) ?? trimNonEmpty(env[GATEWAY_ENV_BASE_URL]);
  const envApiKey =
    trimNonEmpty(env[CLIPROXYAPI_ENV_API_KEY]) ?? trimNonEmpty(env[GATEWAY_ENV_API_KEY]);
  const enabled = persisted?.enabled === true || envBaseUrl !== null || envApiKey !== null;
  if (!enabled) return null;

  const baseUrl = envBaseUrl ?? trimNonEmpty(persisted?.baseUrl);
  const apiKey = envApiKey ?? trimNonEmpty(persisted?.apiKey);
  if (!baseUrl || !apiKey) return null;

  // Canonical Claude form: tolerate a trailing /v1 (Codex/OpenCode form) so
  // both spellings route every harness instead of breaking Claude with
  // a doubled …/v1/v1/models.
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  if (!normalizedBaseUrl) return null;
  return { baseUrl: normalizedBaseUrl, apiKey };
}

/** Compare Gateway URLs across harness forms (`…:8317` vs `…:8317/v1[/]`). */
export function gatewayBaseUrlsMatch(
  first: string | null | undefined,
  second: string | null | undefined,
): boolean {
  if (!first || !second) return false;
  const normalize = (value: string): string =>
    value.trim().replace(/\/+$/, "").replace(/\/v1$/i, "").replace(/\/+$/, "");
  const a = normalize(first);
  const b = normalize(second);
  return a.length > 0 && a.toLowerCase() === b.toLowerCase();
}
type ProviderEnv = Record<string, string | undefined> | undefined;

const CLAUDE_GATEWAY_OPT_OUT_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
];

/**
 * True when a claude provider override configures its own Anthropic routing or
 * account (direct Anthropic keys, Z.AI, Qwen, …) and must not be rerouted.
 */
export function claudeOverrideOptsOutOfGateway(overrideEnv: ProviderEnv): boolean {
  return CLAUDE_GATEWAY_OPT_OUT_KEYS.some((key) => trimNonEmpty(overrideEnv?.[key]) !== null);
}

/** True when a codex provider override already points at its own endpoint. */
export function codexOverrideOptsOutOfGateway(overrideEnv: ProviderEnv): boolean {
  return trimNonEmpty(overrideEnv?.["OPENAI_BASE_URL"]) !== null;
}

const OMP_GATEWAY_OPT_OUT_KEYS = ["LITELLM_BASE_URL", "LITELLM_API_KEY"];

/**
 * True when an omp provider override configures its own LiteLLM routing or
 * credentials and must not be rerouted.
 */
export function ompOverrideOptsOutOfGateway(overrideEnv: ProviderEnv): boolean {
  return OMP_GATEWAY_OPT_OUT_KEYS.some((key) => trimNonEmpty(overrideEnv?.[key]) !== null);
}

/** Env layer merged under explicit provider env for Gateway-routed Claude. */
export function claudeGatewayEnv(gateway: ResolvedGatewayConfig): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: gateway.baseUrl,
    ANTHROPIC_AUTH_TOKEN: gateway.apiKey,
  };
}

/** Env layer merged under explicit provider env for Gateway-routed Codex. */
export function codexGatewayEnv(gateway: ResolvedGatewayConfig): Record<string, string> {
  const baseUrl = gateway.baseUrl.endsWith("/v1") ? gateway.baseUrl : `${gateway.baseUrl}/v1`;
  return {
    OPENAI_BASE_URL: baseUrl,
    OPENAI_API_KEY: gateway.apiKey,
  };
}

/**
 * Env layer merged under explicit provider env for Gateway-routed OMP. The
 * binary exposes the endpoint as its `litellm` provider with the Gateway's
 * model slugs, limits, and thinking levels.
 */
export function ompGatewayEnv(gateway: ResolvedGatewayConfig): Record<string, string> {
  const baseUrl = gateway.baseUrl.endsWith("/v1") ? gateway.baseUrl : `${gateway.baseUrl}/v1`;
  return {
    LITELLM_BASE_URL: baseUrl,
    LITELLM_API_KEY: gateway.apiKey,
  };
}
