// gateway/quota.ts — CLIProxyAPI per-model quota (`GET /v1/quota?model=<id>`).
// Old Gateways predate the route and answer 404 with an empty body; those
// (and every other failure) degrade to unsupported so callers hide quota
// instead of surfacing errors.
import { z } from "zod";

import { decodeCliproxyClaudeModelId } from "./models.js";

export const GATEWAY_QUOTA_TIMEOUT_MS = 10_000;
const GATEWAY_QUOTA_CACHE_TTL_MS = 60_000;

const GatewayQuotaWindowPayloadSchema = z.object({
  name: z.string(),
  used_percent: z.number().optional(),
  reset_at: z.string().optional(),
  status: z.string().optional(),
});

const GatewayQuotaAccountPayloadSchema = z.object({
  provider: z.string(),
  name: z.string().optional(),
  type: z.enum(["oauth", "api"]),
  plan: z.string().optional(),
  in_cooldown: z.boolean(),
  windows_observed_at: z.string().optional(),
  windows: z.array(GatewayQuotaWindowPayloadSchema),
});

const GatewayQuotaResponsePayloadSchema = z.array(GatewayQuotaAccountPayloadSchema);

const GatewayQuotaErrorPayloadSchema = z.object({
  error: z.string(),
});

export interface GatewayQuotaWindow {
  name: string;
  usedPct?: number;
  resetsAt?: string;
  status?: string;
}

export interface GatewayQuotaAccount {
  provider: string;
  name?: string;
  type: "oauth" | "api";
  plan?: string;
  inCooldown: boolean;
  windowsObservedAt?: string;
  windows: GatewayQuotaWindow[];
}

export interface GatewayQuotaResult {
  supported: boolean;
  accounts: GatewayQuotaAccount[];
}

export interface FetchGatewayQuotaOptions {
  baseUrl: string;
  token: string;
  model: string;
  fetchImpl?: typeof fetch;
}

/**
 * Map a Paseo provider model id to the Gateway quota slug. Returns null when
 * the model is not Gateway-routed (native opencode/omp provider prefixes).
 */
export function resolveGatewayQuotaSlug(provider: string, model: string): string | null {
  const trimmed = model.trim();
  if (!trimmed) return null;
  if (provider === "opencode") {
    return stripProviderPrefix(trimmed, "cliproxyapi/");
  }
  if (provider === "omp") {
    return stripProviderPrefix(trimmed, "litellm/");
  }
  if (provider === "claude") {
    return stripQuotaSuffix(decodeCliproxyClaudeModelId(trimmed));
  }
  if (provider === "codex") {
    return stripQuotaSuffix(trimmed);
  }
  return null;
}

function stripProviderPrefix(model: string, prefix: string): string | null {
  if (!model.startsWith(prefix)) return null;
  return stripQuotaSuffix(model.slice(prefix.length));
}

function stripQuotaSuffix(model: string): string | null {
  const stripped = model
    .replace(/\([^()]*\)$/, "")
    .replace(/\[[^\][]*\]$/, "")
    .trim();
  return stripped.length > 0 ? stripped : null;
}

export async function fetchGatewayQuota(
  options: FetchGatewayQuotaOptions,
): Promise<GatewayQuotaResult> {
  const unsupported: GatewayQuotaResult = { supported: false, accounts: [] };
  const url = buildGatewayQuotaUrl(options.baseUrl, options.model);
  if (!url) return unsupported;

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(GATEWAY_QUOTA_TIMEOUT_MS),
    });
  } catch {
    return unsupported;
  }

  if (response.status === 200) {
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = GatewayQuotaResponsePayloadSchema.safeParse(payload);
    if (!parsed.success) return unsupported;
    return { supported: true, accounts: parsed.data.map(mapQuotaAccount) };
  }

  // An error envelope proves the route exists (unknown model, bad key,
  // unavailable auth manager); anything else means an old Gateway without
  // the route, so quota stays hidden either way.
  const payload: unknown = await response.json().catch(() => undefined);
  if (!GatewayQuotaErrorPayloadSchema.safeParse(payload).success) return unsupported;
  return { supported: true, accounts: [] };
}

function mapQuotaAccount(
  account: z.infer<typeof GatewayQuotaAccountPayloadSchema>,
): GatewayQuotaAccount {
  const windowsObservedAt = readTimestamp(account.windows_observed_at);
  return {
    provider: account.provider,
    ...(account.name ? { name: account.name } : {}),
    type: account.type,
    ...(account.plan ? { plan: account.plan } : {}),
    inCooldown: account.in_cooldown,
    ...(windowsObservedAt === undefined ? {} : { windowsObservedAt }),
    windows: account.windows.map((window) => {
      const usedPct = readPercent(window.used_percent);
      const resetsAt = readTimestamp(window.reset_at);
      return {
        name: window.name,
        ...(usedPct === undefined ? {} : { usedPct }),
        ...(resetsAt === undefined ? {} : { resetsAt }),
        ...(window.status ? { status: window.status } : {}),
      };
    }),
  };
}

function readPercent(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function readTimestamp(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function buildGatewayQuotaUrl(baseUrl: string, model: string): string | null {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const slug = model.trim();
  if (!normalizedBaseUrl || !slug) return null;
  try {
    const url = new URL(`${normalizedBaseUrl}/v1/quota`);
    url.searchParams.set("model", slug);
    return url.toString();
  } catch {
    return null;
  }
}

interface GatewayQuotaCacheEntry {
  result: GatewayQuotaResult;
  expiresAt: number;
}

const quotaCache = new Map<string, GatewayQuotaCacheEntry>();
const quotaInflight = new Map<string, Promise<GatewayQuotaResult>>();

export function clearGatewayQuotaCache(): void {
  quotaCache.clear();
  quotaInflight.clear();
}

/**
 * Cached quota fetch shared across sessions. Both usable results and
 * unsupported outcomes cache briefly; concurrent callers share one flight.
 */
export async function getCachedGatewayQuota(
  options: FetchGatewayQuotaOptions,
  now: () => number = Date.now,
): Promise<GatewayQuotaResult> {
  const key = `${options.baseUrl.trim()} ${options.model.trim()}`;
  const cached = quotaCache.get(key);
  if (cached && now() < cached.expiresAt) return cached.result;

  const inflight = quotaInflight.get(key);
  if (inflight) return inflight;

  const pending = fetchGatewayQuota(options).then((result) => {
    quotaInflight.delete(key);
    quotaCache.set(key, { result, expiresAt: now() + GATEWAY_QUOTA_CACHE_TTL_MS });
    return result;
  });
  quotaInflight.set(key, pending);
  return pending;
}
