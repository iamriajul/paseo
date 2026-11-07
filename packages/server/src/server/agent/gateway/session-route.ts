// gateway/session-route.ts — the CLIProxyAPI account serving one agent session
// (`GET /v1/session-route?session=<canonical id>`).
// The route only exists on newer Gateways; anything other than a well-formed
// 200 record (404 "never served", 404 on a build without the route, bad key,
// transport failure) reports no route so callers render nothing.
import { z } from "zod";
import type { AgentProvider } from "../agent-sdk-types.js";

export const GATEWAY_SESSION_ROUTE_TIMEOUT_MS = 10_000;
/** Matches the quota cache: the tooltip re-reads on open, the turn watcher bypasses it. */
export const GATEWAY_SESSION_ROUTE_CACHE_TTL_MS = 15_000;

const AccountPayloadSchema = z.object({
  provider: z.string(),
  provider_name: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  plan: z.string().optional(),
  in_cooldown: z.boolean(),
  cooldown_until: z.string().optional(),
});

const SessionRoutePayloadSchema = z.object({
  session: z.string(),
  account: AccountPayloadSchema,
  model: z.string().optional(),
  since: z.string(),
  last_seen: z.string(),
  switches: z.array(
    z.object({
      at: z.string(),
      from: AccountPayloadSchema,
      to: AccountPayloadSchema,
      reason: z.string(),
      status_code: z.number().optional(),
    }),
  ),
});

export interface GatewayRouteAccount {
  /** Masked account name, or the provider name once the account was removed. */
  label: string;
  provider: string;
  plan?: string;
  inCooldown: boolean;
  /** When the cooldown ends, on Gateways that report it. */
  cooldownUntil?: string;
}

export interface GatewayRouteSwitch {
  at: string;
  from: GatewayRouteAccount;
  to: GatewayRouteAccount;
  /** "quota" | "cooldown" | "error" | "rebind", or a newer value the Gateway added. */
  reason: string;
  statusCode?: number;
}

export interface GatewaySessionRoute {
  account: GatewayRouteAccount;
  since: string;
  switches: GatewayRouteSwitch[];
}

export interface GatewaySessionRouteResult {
  supported: boolean;
  route: GatewaySessionRoute | null;
}

export interface FetchGatewaySessionRouteOptions {
  baseUrl: string;
  token: string;
  /** Canonical CLIProxyAPI session id, e.g. `claude:<session id>`. */
  session: string;
  fetchImpl?: typeof fetch;
}

/**
 * The canonical id CLIProxyAPI derives from each harness's session header, so
 * the lookup matches what the router recorded. Providers whose harness sends
 * no session header the router reads get null.
 */
export function gatewaySessionIdFor(
  provider: AgentProvider,
  sessionId: string | null | undefined,
): string | null {
  const id = sessionId?.trim();
  if (!id) return null;
  switch (provider) {
    // X-Claude-Code-Session-Id
    case "claude":
      return `claude:${id}`;
    // Codex sends its thread id as the session_id header.
    case "codex":
      return `codex:${id}`;
    // OpenCode sends X-Session-Id (and x-session-affinity) for non-OpenCode
    // providers; the Gateway keys X-Session-Id as "header:".
    case "opencode":
      return `header:${id}`;
    default:
      return null;
  }
}

/**
 * The provider session id the agent's requests carry to the gateway: a native fork names its root
 * session (`sessionAffinityId`) so it shares that session's account and cache.
 */
export function gatewayRoutedSessionId(agent: {
  config: { providerOptions?: Record<string, unknown> };
  persistence?: { sessionId?: string | null } | null;
}): string | null {
  const affinity = agent.config.providerOptions?.sessionAffinityId;
  if (typeof affinity === "string" && affinity.trim()) return affinity;
  return agent.persistence?.sessionId ?? null;
}

/**
 * Provider options a new session may take over from the agent that made it (`create_agent`
 * children, schedule targets). The affinity stays behind: a fresh session shares no cached prefix
 * with the root, so pinning it would only stack the family on one account and repeat every
 * account switch in each agent's timeline. Only `nativeForkAgent`, whose session does share the
 * prefix, carries it.
 */
export function inheritableProviderOptions(
  options: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!options) return undefined;
  const { sessionAffinityId: _sessionAffinityId, ...rest } = options;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

export async function fetchGatewaySessionRoute(
  options: FetchGatewaySessionRouteOptions,
): Promise<GatewaySessionRouteResult> {
  const empty: GatewaySessionRouteResult = { supported: false, route: null };
  const url = buildSessionRouteUrl(options.baseUrl, options.session);
  if (!url) return empty;

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(GATEWAY_SESSION_ROUTE_TIMEOUT_MS),
    });
  } catch {
    return empty;
  }
  if (response.status !== 200) return empty;

  const payload: unknown = await response.json().catch(() => undefined);
  const parsed = SessionRoutePayloadSchema.safeParse(payload);
  if (!parsed.success) return empty;
  return {
    supported: true,
    route: {
      account: mapAccount(parsed.data.account),
      since: parsed.data.since,
      switches: parsed.data.switches.map(mapSwitch),
    },
  };
}

const routeCache = new Map<
  string,
  { result: GatewaySessionRouteResult; fetchedAt: number; expiresAt: number }
>();

/**
 * Briefly cached read for the tooltip; the switch watcher reads uncached. `maxAgeMs` tightens the
 * cache for a caller that acts on the answer, like the warm-up account check.
 */
export async function getCachedGatewaySessionRoute(
  options: FetchGatewaySessionRouteOptions & { maxAgeMs?: number },
  now: () => number = Date.now,
): Promise<GatewaySessionRouteResult> {
  const key = `${options.baseUrl.trim()} ${options.session}`;
  const cached = routeCache.get(key);
  if (
    cached &&
    now() < cached.expiresAt &&
    (options.maxAgeMs === undefined || now() - cached.fetchedAt < options.maxAgeMs)
  ) {
    return cached.result;
  }
  const result = await fetchGatewaySessionRoute(options);
  const fetchedAt = now();
  routeCache.set(key, {
    result,
    fetchedAt,
    expiresAt: fetchedAt + GATEWAY_SESSION_ROUTE_CACHE_TTL_MS,
  });
  for (const [entryKey, entry] of routeCache) {
    if (now() >= entry.expiresAt) routeCache.delete(entryKey);
  }
  return result;
}

function mapSwitch(entry: z.infer<typeof SessionRoutePayloadSchema>["switches"][number]) {
  const mapped: GatewayRouteSwitch = {
    at: entry.at,
    from: mapAccount(entry.from),
    to: mapAccount(entry.to),
    reason: entry.reason,
  };
  if (entry.status_code) mapped.statusCode = entry.status_code;
  return mapped;
}

function mapAccount(account: z.infer<typeof AccountPayloadSchema>): GatewayRouteAccount {
  const providerName = account.provider_name?.trim() || account.provider;
  const plan = account.plan?.trim();
  return {
    label: account.name?.trim() || providerName,
    provider: providerName,
    ...(plan ? { plan } : {}),
    inCooldown: account.in_cooldown,
    ...(account.cooldown_until && !Number.isNaN(Date.parse(account.cooldown_until))
      ? { cooldownUntil: account.cooldown_until }
      : {}),
  };
}

function buildSessionRouteUrl(baseUrl: string, session: string): string | null {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  if (!normalizedBaseUrl || !session) return null;
  try {
    const url = new URL(`${normalizedBaseUrl}/v1/session-route`);
    url.searchParams.set("session", session);
    return url.toString();
  } catch {
    return null;
  }
}
