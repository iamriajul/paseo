import type { GatewayQuotaPayload } from "./types";
import type { ProviderUsageWindow } from "@/provider-usage/types";

export interface GatewayQuotaSectionModel {
  key: string;
  heading: string;
  inCooldown: boolean;
  windows: ProviderUsageWindow[];
}

/**
 * Group quota accounts CPAMC-style for display. Returns no sections when the
 * Gateway predates the quota endpoint or no account serves the model, so the
 * tooltip hides the section instead of showing an error.
 */
export function buildGatewayQuotaSections(
  payload: GatewayQuotaPayload,
): GatewayQuotaSectionModel[] {
  if (!payload.supported || payload.accounts.length === 0) return [];
  return payload.accounts.map((account, index) => {
    const headingParts = [account.provider];
    if (account.plan) headingParts.push(account.plan);
    if (account.name) headingParts.push(account.name);
    return {
      key: `${account.provider}/${account.name ?? index}`,
      heading: headingParts.join(" · "),
      inCooldown: account.inCooldown,
      windows: account.windows.map((window, windowIndex) => ({
        id: `${account.provider}/${account.name ?? index}/${window.name}/${windowIndex}`,
        label: window.name,
        usedPct: window.usedPct ?? null,
        resetsAt: window.resetsAt ?? null,
      })),
    };
  });
}
