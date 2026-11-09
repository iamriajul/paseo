// User-facing copy for the CLIProxyAPI account surfaces (meter details, All accounts window,
// Usage tab), centralized so localization is a single-file change. Mirrors providerUsageCopy.
export const gatewayQuotaCopy = {
  title: "CLIProxyAPI account",
  loading: "Loading CLIProxyAPI quota…",
  hostUnavailable: "Connect to this host to see CLIProxyAPI quota",
  hostUpgradeRequired: "Update the host to see CLIProxyAPI quota",
  clientUnavailable: "Host connection is not ready",
  missingContext: "Select a CLIProxyAPI model to see quota",
  coolingDown: "Cooling down",
  usedUp: "Quota used up",
  usable: "Usable now",
  servingBadge: "Serving this agent",
  allAccounts: "All accounts…",
  allAccountsTitle: "CLIProxyAPI accounts",
  model: "Model",
  searchModels: "Search models",
  noAccounts: "No CLIProxyAPI account can serve this model.",
  unsupported: "This CLIProxyAPI build does not report quota for this model.",
} as const;

/** "+3 more accounts can serve this model", or the whole count when no account is serving. */
export function describeOtherAccounts(others: number, hasServing: boolean): string | null {
  if (others === 0) return null;
  const noun = others === 1 ? "account" : "accounts";
  return hasServing
    ? `+${others} more ${noun} can serve this model`
    : `${others} ${noun} can serve this model`;
}

/** The All accounts window's count line: "14 accounts · 10 usable now · 4 blocked". */
export function describeAccountSummary(summary: {
  total: number;
  usable: number;
  blocked: number;
}): string {
  const parts = [`${summary.total} ${summary.total === 1 ? "account" : "accounts"}`];
  if (summary.usable > 0) parts.push(`${summary.usable} usable now`);
  if (summary.blocked > 0) parts.push(`${summary.blocked} blocked`);
  return parts.join(" · ");
}
