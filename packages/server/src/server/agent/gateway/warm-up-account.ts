// gateway/warm-up-account.ts — whether the CLIProxyAPI account serving an agent can take a warm-up.
//
// A warm-up only keeps the cache of the account that serves the session. When that account cannot
// serve, the Gateway either rejects the warm-up or moves the session to another account and writes
// the whole context there cold. So every warm-up first confirms the serving account can still
// serve; when it cannot, or Paseo cannot confirm it, the warm-up is skipped and the cache left to
// expire (the user's rule, 2026-11-11). The answer is read right before a warm-up is sent: the
// session route names the serving account, `/v1/quota` for the agent's model says whether it is
// blocked. Only an agent the Gateway does not route warms unchecked.
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

/**
 * The Gateway records a request at its start, the daemon at its `message_start`, on two clocks. A
 * route that changed account this long after the agent's last request moved after it.
 */
export const WARM_UP_ROUTE_MOVED_SLACK_MS = 5_000;

/**
 * Why the warm-up cannot go to the account that holds the cache.
 * - "quota": one of its quota windows is used up.
 * - "cooldown": it is cooling down, unavailable or disabled for the model (the Gateway folds all of
 *   these into `in_cooldown`).
 * - "unlisted": the quota list for the model no longer shows it (disabled, removed, or it no
 *   longer serves the model).
 * - "moved": the session route already names another account than the one that served the
 *   agent's last request; the warm-up would only write the whole context there cold.
 * - "untracked": the Gateway serves the route but does not track the session (never served, or
 *   idle past its hour), so it would pick an account afresh.
 * - "unsupported": the Gateway has no `/v1/session-route`, so nothing can say which account serves.
 * - "unconfirmed": the Gateway did not answer.
 */
export type WarmUpAccountBlockReason =
  | "quota"
  | "cooldown"
  | "unlisted"
  | "moved"
  | "untracked"
  | "unsupported"
  | "unconfirmed";

export interface WarmUpAccountBlock {
  reason: WarmUpAccountBlockReason;
  /**
   * Masked account label, as `/v1/quota` shows it: the serving account, or for "moved" the account
   * the session moved to. Empty when no account is known ("untracked", "unsupported",
   * "unconfirmed").
   */
  account: string;
  /** When the account can serve again, when the Gateway says: the window reset or cooldown end. */
  until?: string;
  /** The used-up window's name ("5h", "7d"), for a quota block. */
  window?: string;
  /** For "unconfirmed": when the manager reads again, while the cache is still warm enough. */
  retryAt?: string;
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
  /** When the agent's last request was recorded: the cache the warm-up would keep. */
  lastRequestAtMs: number | null;
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

/**
 * Null when the serving account can take the warm-up, or when the Gateway does not route the
 * agent at all. Anything Paseo cannot confirm blocks: a warm-up that goes out unchecked can write
 * the whole context cold on another account, while a skipped one costs at most the cache.
 */
export async function readWarmUpAccountBlock(
  input: ReadWarmUpAccountBlockInput,
): Promise<WarmUpAccountBlock | null> {
  const { agent, gateway } = input;
  if (!gateway || !input.isGatewayRouted(agent.provider)) return null;
  const session = gatewaySessionIdFor(agent.provider, gatewayRoutedSessionId(agent));
  const model = agent.config.model
    ? resolveGatewayModelSlug(agent.provider, agent.config.model)
    : null;
  if (!session || !model) return { reason: "unconfirmed", account: "" };

  const base = {
    baseUrl: gateway.baseUrl,
    token: gateway.apiKey,
    maxAgeMs: WARM_UP_ACCOUNT_CHECK_MAX_AGE_MS,
  };
  const readRoute = input.readRoute ?? getCachedGatewaySessionRoute;
  const readQuota = input.readQuota ?? getCachedGatewayQuota;
  const [routeResult, quota] = await Promise.all([
    readRoute({ ...base, session }),
    readQuota({ ...base, model }),
  ]);
  if (routeResult.failed || quota.failed) return { reason: "unconfirmed", account: "" };
  const { route } = routeResult;
  if (!route) {
    return { reason: routeResult.supported ? "untracked" : "unsupported", account: "" };
  }
  const serving = route.account;
  if (movedSince(route.since, input.lastRequestAtMs)) {
    return { reason: "moved", account: serving.label };
  }
  return servingAccountBlock(serving, quota);
}

/** Whether the account the route names can serve, by its quota row and cooldown. */
function servingAccountBlock(
  serving: GatewayRouteAccount,
  quota: GatewayQuotaResult,
): WarmUpAccountBlock | null {
  // A Gateway without `/v1/quota` still names the account and its cooldown; that is all it can say.
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
  if (quota.supported && accounts.length === 0) {
    return { reason: "unlisted", account: serving.label };
  }
  return null;
}

function movedSince(since: string, lastRequestAtMs: number | null): boolean {
  const sinceMs = Date.parse(since);
  return (
    lastRequestAtMs !== null &&
    Number.isFinite(sinceMs) &&
    sinceMs > lastRequestAtMs + WARM_UP_ROUTE_MOVED_SLACK_MS
  );
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
