import type { Logger } from "pino";
import type {
  ProviderUsage,
  ProviderUsageResetQuotaResponseMessage,
} from "../../server/messages.js";

export type ProviderApiFetch = typeof fetch;
export type ProviderUsageResetQuotaResult = Omit<
  ProviderUsageResetQuotaResponseMessage["payload"],
  "requestId"
>;

export interface ProviderUsageFetcher {
  readonly providerId: string;
  readonly displayName: string;
  fetchUsage(): Promise<ProviderUsage>;
  resetQuota?(): Promise<ProviderUsageResetQuotaResult>;
}

export interface ProviderUsageFetcherFactoryOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
}

export interface ProviderUsageFetcherManifestEntry {
  readonly providerId: string;
  create(options: ProviderUsageFetcherFactoryOptions): ProviderUsageFetcher;
}
