// gateway/quota.ts — CLIProxyAPI per-model quota (`GET /v1/quota?model=<id>`).
// Old Gateways predate the route and answer 404 with an empty body; those
// (and every other failure) degrade to unsupported so callers hide quota
// instead of surfacing errors.
import { z } from "zod";

export const GATEWAY_QUOTA_TIMEOUT_MS = 10_000;
const GATEWAY_QUOTA_CACHE_TTL_MS = 60_000;

const GatewayQuotaWindowPayloadSchema = z.object({
  name: z.string(),
  used_percent: z.number().optional(),
  reset_at: z.string().optional(),
  status: z.string().optional(),
});

const GatewayQuotaResetCreditPayloadSchema = z.object({
  expires_at: z.string(),
});

const GatewayQuotaAccountPayloadSchema = z.object({
  provider: z.string(),
  provider_name: z.string().optional(),
  name: z.string().optional(),
  type: z.enum(["oauth", "api"]),
  plan: z.string().optional(),
  in_cooldown: z.boolean(),
  cooldown_until: z.string().optional(),
  windows_observed_at: z.string().optional(),
  windows: z.array(GatewayQuotaWindowPayloadSchema),
  reset_credits: z.array(GatewayQuotaResetCreditPayloadSchema).optional(),
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

export interface GatewayQuotaResetCredit {
  expiresAt: string;
}

export interface GatewayQuotaAccount {
  provider: string;
  providerName?: string;
  name?: string;
  type: "oauth" | "api";
  plan?: string;
  inCooldown: boolean;
  /** When the cooldown ends, on Gateways that report it. */
  cooldownUntil?: string;
  windowsObservedAt?: string;
  windows: GatewayQuotaWindow[];
  resetCredits?: GatewayQuotaResetCredit[];
}

export interface GatewayQuotaResult {
  supported: boolean;
  accounts: GatewayQuotaAccount[];
  /**
   * The Gateway gave no usable answer: transport failure, timeout, an unparseable 200, an error
   * envelope other than 404 "no serving account" (bad key, auth manager unavailable), or an error
   * status other than a plain 404 (a build without the route). The UI hides quota either way;
   * the warm-up account check must not read it as "no block".
   */
  failed?: true;
}

export interface FetchGatewayQuotaOptions {
  baseUrl: string;
  token: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export async function fetchGatewayQuota(
  options: FetchGatewayQuotaOptions,
): Promise<GatewayQuotaResult> {
  const unsupported: GatewayQuotaResult = { supported: false, accounts: [] };
  const failed: GatewayQuotaResult = { supported: false, accounts: [], failed: true };
  const url = buildGatewayQuotaUrl(options.baseUrl, options.model);
  if (!url) return failed;

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(GATEWAY_QUOTA_TIMEOUT_MS),
    });
  } catch {
    return failed;
  }

  if (response.status === 200) {
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = GatewayQuotaResponsePayloadSchema.safeParse(payload);
    if (!parsed.success) return failed;
    return { supported: true, accounts: parsed.data.map(mapQuotaAccount) };
  }

  // An error envelope proves the route exists (unknown model, bad key,
  // unavailable auth manager); anything else means an old Gateway without
  // the route, so quota stays hidden either way.
  const payload: unknown = await response.json().catch(() => undefined);
  if (!GatewayQuotaErrorPayloadSchema.safeParse(payload).success) {
    return response.status === 404 ? unsupported : failed;
  }
  // 404 means no account serves the model: an answer. Any other error is not one.
  return response.status === 404
    ? { supported: true, accounts: [] }
    : { supported: true, accounts: [], failed: true };
}

function mapQuotaAccount(
  account: z.infer<typeof GatewayQuotaAccountPayloadSchema>,
): GatewayQuotaAccount {
  const windowsObservedAt = readTimestamp(account.windows_observed_at);
  const cooldownUntil = readTimestamp(account.cooldown_until);
  const resetCredits = (account.reset_credits ?? [])
    .map((credit) => readTimestamp(credit.expires_at))
    .filter((expiresAt): expiresAt is string => expiresAt !== undefined)
    .map((expiresAt) => ({ expiresAt }));
  return {
    provider: account.provider,
    ...(account.provider_name ? { providerName: account.provider_name } : {}),
    ...(account.name ? { name: account.name } : {}),
    type: account.type,
    ...(account.plan ? { plan: account.plan } : {}),
    inCooldown: account.in_cooldown,
    ...(cooldownUntil === undefined ? {} : { cooldownUntil }),
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
    ...(resetCredits.length === 0 ? {} : { resetCredits }),
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

function buildGatewayQuotaUrl(baseUrl: string, model?: string): string | null {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  if (!normalizedBaseUrl) return null;
  try {
    const url = new URL(`${normalizedBaseUrl}/v1/quota`);
    const slug = model?.trim();
    if (slug) url.searchParams.set("model", slug);
    return url.toString();
  } catch {
    return null;
  }
}

interface GatewayQuotaCacheEntry {
  result: GatewayQuotaResult;
  fetchedAt: number;
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
  options: FetchGatewayQuotaOptions & { maxAgeMs?: number },
  now: () => number = Date.now,
): Promise<GatewayQuotaResult> {
  const key = `${options.baseUrl.trim()} ${options.model.trim()}`;
  const cached = quotaCache.get(key);
  // `maxAgeMs` tightens the cache for a caller that acts on the answer (the warm-up check).
  if (
    cached &&
    now() < cached.expiresAt &&
    (options.maxAgeMs === undefined || now() - cached.fetchedAt < options.maxAgeMs)
  ) {
    return cached.result;
  }

  const inflight = quotaInflight.get(key);
  if (inflight) return inflight;

  const pending = fetchGatewayQuota(options).then((result) => {
    quotaInflight.delete(key);
    const fetchedAt = now();
    quotaCache.set(key, { result, fetchedAt, expiresAt: fetchedAt + GATEWAY_QUOTA_CACHE_TTL_MS });
    return result;
  });
  quotaInflight.set(key, pending);
  return pending;
}
