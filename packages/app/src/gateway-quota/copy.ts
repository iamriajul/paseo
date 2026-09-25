// User-facing copy for the Gateway quota tooltip section, centralized so
// localization is a single-file change. Mirrors providerUsageCopy.
export const gatewayQuotaCopy = {
  title: "Gateway quota",
  loading: "Loading Gateway quota…",
  hostUnavailable: "Connect to this host to see Gateway quota",
  hostUpgradeRequired: "Update the host to see Gateway quota",
  clientUnavailable: "Host connection is not ready",
  coolingDown: "Cooling down",
} as const;
