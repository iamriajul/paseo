// User-facing copy for the CLIProxyAPI quota tooltip section, centralized so
// localization is a single-file change. Mirrors providerUsageCopy.
export const gatewayQuotaCopy = {
  title: "CLIProxyAPI quota",
  loading: "Loading CLIProxyAPI quota…",
  hostUnavailable: "Connect to this host to see CLIProxyAPI quota",
  hostUpgradeRequired: "Update the host to see CLIProxyAPI quota",
  clientUnavailable: "Host connection is not ready",
  missingContext: "Select a CLIProxyAPI model to see quota",
  coolingDown: "Cooling down",
} as const;
