import type { GatewayQuotaAccount, GatewayQuotaPayload } from "./types";

export interface GatewayQuotaSectionModel {
  key: string;
  account: GatewayQuotaAccount;
}

export interface GatewayQuotaSummary {
  total: number;
  ready: number;
  coolingDown: number;
}

/** Worst (highest) used window on the account, so the most drained account sorts last. */
function worstUsedPct(account: GatewayQuotaAccount): number {
  let worst = -1;
  for (const window of account.windows) {
    if (window.usedPct != null) worst = Math.max(worst, window.usedPct);
  }
  return worst;
}

/**
 * Order accounts for display: usable accounts first (least used), the
 * cooling-down ones last. Returns no sections when the Gateway predates the
 * quota endpoint or no account serves the model, so the tooltip hides the
 * section instead of showing an error.
 */
export function buildGatewayQuotaSections(
  payload: GatewayQuotaPayload,
): GatewayQuotaSectionModel[] {
  if (!payload.supported || payload.accounts.length === 0) return [];
  return payload.accounts
    .map((account, index) => ({
      key: `${account.provider}/${account.name ?? index}`,
      account,
    }))
    .sort((a, b) => {
      if (a.account.inCooldown !== b.account.inCooldown) return a.account.inCooldown ? 1 : -1;
      const usedDelta = worstUsedPct(a.account) - worstUsedPct(b.account);
      if (usedDelta !== 0) return usedDelta;
      const providerDelta = a.account.provider.localeCompare(b.account.provider);
      if (providerDelta !== 0) return providerDelta;
      return (a.account.name ?? "").localeCompare(b.account.name ?? "");
    });
}

export function summarizeGatewayQuota(sections: GatewayQuotaSectionModel[]): GatewayQuotaSummary {
  let coolingDown = 0;
  for (const section of sections) {
    if (section.account.inCooldown) coolingDown += 1;
  }
  return { total: sections.length, ready: sections.length - coolingDown, coolingDown };
}
