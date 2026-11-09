import type { GatewaySessionRoute } from "@getpaseo/protocol/messages";
import type { GatewayQuotaAccount, GatewayQuotaPayload } from "./types";

type GatewayRouteAccount = GatewaySessionRoute["account"];

/** A window at or past this share is used up: the Gateway will not route to the account. */
export const QUOTA_WINDOW_USED_UP_PCT = 100;

/**
 * Whether the Gateway can route a request to the account right now. A blocked account says why
 * and, when the Gateway reports it, when it serves again.
 */
export type GatewayAccountAvailability =
  | { kind: "usable" }
  | { kind: "blocked"; reason: "cooldown" | "quota"; until: string | null };

export interface GatewayAccountEntry {
  key: string;
  account: GatewayQuotaAccount;
  availability: GatewayAccountAvailability;
  /** The account the agent's session is on, per the session route. */
  serving: boolean;
}

export interface GatewayAccountSummary {
  total: number;
  usable: number;
  blocked: number;
}

function latestIso(values: readonly (string | undefined | null)[]): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (!value || Number.isNaN(Date.parse(value))) continue;
    if (latest === null || Date.parse(value) > Date.parse(latest)) latest = value;
  }
  return latest;
}

/**
 * Cooldown wins over a used-up window because the Gateway reports its end directly. A used-up
 * account serves again only once every used-up window resets, so `until` is the latest reset.
 */
export function gatewayAccountAvailability(
  account: GatewayQuotaAccount,
): GatewayAccountAvailability {
  if (account.inCooldown) {
    return { kind: "blocked", reason: "cooldown", until: account.cooldownUntil ?? null };
  }
  const usedUp = account.windows.filter(
    (window) => window.usedPct != null && window.usedPct >= QUOTA_WINDOW_USED_UP_PCT,
  );
  if (usedUp.length > 0) {
    return { kind: "blocked", reason: "quota", until: latestIso(usedUp.map((w) => w.resetsAt)) };
  }
  return { kind: "usable" };
}

/**
 * The session route and `/v1/quota` mask account names the same way, so a quota row is the
 * serving account when its label and provider name match. Two accounts can share a masked label;
 * every row that does matches (the daemon's warm-up check reads it the same way).
 */
export function isServingAccount(
  account: GatewayQuotaAccount,
  serving: GatewayRouteAccount | null | undefined,
): boolean {
  if (!serving || !account.name) return false;
  return (
    account.name === serving.label &&
    (account.providerName ?? account.provider) === serving.provider
  );
}

/** Worst (highest) used window, so the most drained usable account sorts last among them. */
function worstUsedPct(account: GatewayQuotaAccount): number {
  let worst = -1;
  for (const window of account.windows) {
    if (window.usedPct != null) worst = Math.max(worst, window.usedPct);
  }
  return worst;
}

function compareEntries(a: GatewayAccountEntry, b: GatewayAccountEntry): number {
  if (a.serving !== b.serving) return a.serving ? -1 : 1;
  const aBlocked = a.availability.kind === "blocked";
  const bBlocked = b.availability.kind === "blocked";
  if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
  if (a.availability.kind === "blocked" && b.availability.kind === "blocked") {
    // Soonest back first; an account with no known reset goes last.
    const aUntil = a.availability.until ? Date.parse(a.availability.until) : Infinity;
    const bUntil = b.availability.until ? Date.parse(b.availability.until) : Infinity;
    if (aUntil !== bUntil) return aUntil < bUntil ? -1 : 1;
  } else {
    const usedDelta = worstUsedPct(a.account) - worstUsedPct(b.account);
    if (usedDelta !== 0) return usedDelta;
  }
  const providerDelta = a.account.provider.localeCompare(b.account.provider);
  if (providerDelta !== 0) return providerDelta;
  return (a.account.name ?? "").localeCompare(b.account.name ?? "");
}

/**
 * Every account that can serve the model: the serving account on top, whatever its state, then
 * usable ones (least used first), then blocked ones (soonest back first). Callers that should not
 * pin it (another model than the agent's) pass no serving account. Empty when the Gateway predates `/v1/quota` or no account serves the
 * model, so callers hide the list instead of showing an error.
 */
export function buildGatewayAccountList(
  payload: GatewayQuotaPayload,
  serving: GatewayRouteAccount | null | undefined,
): GatewayAccountEntry[] {
  if (!payload.supported) return [];
  return payload.accounts
    .map((account, index) => ({
      key: `${account.provider}/${account.name ?? ""}/${index}`,
      account,
      availability: gatewayAccountAvailability(account),
      serving: isServingAccount(account, serving),
    }))
    .sort(compareEntries);
}

export function summarizeGatewayAccounts(
  entries: readonly GatewayAccountEntry[],
): GatewayAccountSummary {
  let blocked = 0;
  for (const entry of entries) {
    if (entry.availability.kind === "blocked") blocked += 1;
  }
  return { total: entries.length, usable: entries.length - blocked, blocked };
}
