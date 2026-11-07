// gateway/warm-up-account.ts — whether the CLIProxyAPI account serving an agent can take a warm-up.
//
// A warm-up only keeps the cache of the account that serves the session. When that account is
// cooling down, or one of its quota windows is used up, the Gateway either rejects the warm-up or
// moves the session to another account and writes the whole context there cold; the blocked
// account's cache expires long before it recovers anyway. So a warm-up while blocked only costs
// money, and the warm-up manager pauses instead.
//
// The answer is read right before a warm-up is sent: the session route names the serving
// account, `/v1/quota` for the agent's model says whether that account is blocked. Anything the
// Gateway cannot answer (an unrouted agent, a Gateway without either route, an account the quota
// list does not show) reports no block, so warm-up behaves as it did before this check.
import type { GatewayQuotaAccount, GatewayQuotaResult } from "./quota.js";
import { getCachedGatewayQuota } from "./quota.js";
import type { GatewayRouteAccount, GatewaySessionRouteResult } from "./session-route.js";
import {
  gatewayRoutedSessionId,
  gatewaySessionIdFor,
  getCachedGatewaySessionRoute,
} from "./session-route.js";
import { resolveGatewayModelSlug } from "./slug.js";

/** Fresh enough to act on at send time, while two warm-ups in a row still share one read. */
export const WARM_UP_ACCOUNT_CHECK_MAX_AGE_MS = 10_000;

/** A quota window at or above this share is used up. */
const QUOTA_WINDOW_USED_UP_PCT = 100;

export interface WarmUpAccountBlock {
  /** "cooldown": the account is cooling down; "quota": one of its quota windows is used up. */
  reason: "cooldown" | "quota";
  /** Masked account label, as `/v1/quota` shows it. */
  account: string;
  /** When the account can serve again, when the Gateway says: the window reset or cooldown end. */
  until?: string;
  /** The used-up window's name ("5h", "7d"), for a quota block. */
  window?: string;
}

/** The fields a loaded agent and its stored record share. */
export interface WarmUpAccountAgent {
  provider: string;
  config: { model?: string | null; providerOptions?: Record<string, unknown> };
  persistence?: { sessionId?: string | null } | null;
}

export interface WarmUpAccountGateway {
  baseUrl: string;
  apiKey: string;
}

export interface ReadWarmUpAccountBlockInput {
  agent: WarmUpAccountAgent;
  gateway: WarmUpAccountGateway | null | undefined;
  isGatewayRouted: (provider: string) => boolean;
  readRoute?: (options: {
    baseUrl: string;
    token: string;
    session: string;
    maxAgeMs: number;
  }) => Promise<GatewaySessionRouteResult>;
  readQuota?: (options: {
    baseUrl: string;
    token: string;
    model: string;
    maxAgeMs: number;
  }) => Promise<GatewayQuotaResult>;
}

export async function readWarmUpAccountBlock(
  input: ReadWarmUpAccountBlockInput,
): Promise<WarmUpAccountBlock | null> {
  const { agent, gateway } = input;
  if (!gateway || !input.isGatewayRouted(agent.provider)) return null;
  const session = gatewaySessionIdFor(agent.provider, gatewayRoutedSessionId(agent));
  const model = agent.config.model
    ? resolveGatewayModelSlug(agent.provider, agent.config.model)
    : null;
  if (!session || !model) return null;

  const base = {
    baseUrl: gateway.baseUrl,
    token: gateway.apiKey,
    maxAgeMs: WARM_UP_ACCOUNT_CHECK_MAX_AGE_MS,
  };
  const readRoute = input.readRoute ?? getCachedGatewaySessionRoute;
  const readQuota = input.readQuota ?? getCachedGatewayQuota;
  const [{ route }, quota] = await Promise.all([
    readRoute({ ...base, session }),
    readQuota({ ...base, model }),
  ]);
  if (!route) return null;
  const serving = route.account;
  const accounts = quota.supported ? quotaAccountsFor(serving, quota.accounts) : [];

  const usedUp = usedUpWindow(accounts);
  if (usedUp) {
    return {
      reason: "quota",
      account: serving.label,
      window: usedUp.window,
      ...(usedUp.until ? { until: usedUp.until } : {}),
    };
  }
  if (serving.inCooldown || (accounts.length > 0 && accounts.every((a) => a.inCooldown))) {
    const until = serving.cooldownUntil ?? latest(accounts.map((a) => a.cooldownUntil));
    return { reason: "cooldown", account: serving.label, ...(until ? { until } : {}) };
  }
  return null;
}

/**
 * The quota rows for the serving account. Both routes mask the same way, so a row matches on its
 * label and provider name. Two accounts can share a masked label; every row that does is returned
 * and the caller only blocks when all of them agree.
 */
function quotaAccountsFor(
  serving: GatewayRouteAccount,
  accounts: readonly GatewayQuotaAccount[],
): GatewayQuotaAccount[] {
  return accounts.filter(
    (account) =>
      account.name === serving.label &&
      (account.providerName ?? account.provider) === serving.provider,
  );
}

/**
 * A used-up window, when every matching row has one. The account serves again only once all its
 * used-up windows reset, so `until` is the latest of their resets.
 */
function usedUpWindow(
  accounts: readonly GatewayQuotaAccount[],
): { window: string; until?: string } | null {
  if (accounts.length === 0) return null;
  let window: string | null = null;
  const resets: (string | undefined)[] = [];
  for (const account of accounts) {
    const full = account.windows.filter(
      (entry) => entry.usedPct !== undefined && entry.usedPct >= QUOTA_WINDOW_USED_UP_PCT,
    );
    if (full.length === 0) return null;
    window ??= full[0]!.name;
    resets.push(...full.map((entry) => entry.resetsAt));
  }
  const until = latest(resets);
  return window ? { window, ...(until ? { until } : {}) } : null;
}

function latest(times: readonly (string | undefined)[]): string | undefined {
  let best: string | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const time of times) {
    const ms = time ? Date.parse(time) : Number.NaN;
    if (Number.isFinite(ms) && ms > bestMs) {
      best = time;
      bestMs = ms;
    }
  }
  return best;
}
