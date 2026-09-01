import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";
import { createProviderUsageFetchers } from "./manifest.js";
import type {
  ProviderApiFetch,
  ProviderUsageFetcher,
  ProviderUsageResetQuotaResult,
} from "./provider.js";
import { unavailableUsage } from "./usage.js";

export interface ProviderUsageServiceOptions {
  logger: Logger;
  fetchers?: ProviderUsageFetcher[];
  fetch?: ProviderApiFetch;
  cacheTtlMs?: number;
  now?: () => number;
}

export interface ProviderUsageListResult {
  fetchedAt: string;
  providers: ProviderUsage[];
}

const DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

interface ProviderUsageInFlight {
  request: Promise<ProviderUsageListResult>;
  generation: number;
  epoch: number;
  forceRefresh: boolean;
}

export class ProviderUsageService {
  private readonly logger: Logger;
  private readonly fetchers: ProviderUsageFetcher[];
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cached: { fetchedAtMs: number; result: ProviderUsageListResult } | null = null;
  private inFlight: ProviderUsageInFlight | null = null;
  private generation = 0;
  private latestEpoch = 0;

  constructor(options: ProviderUsageServiceOptions) {
    this.logger = options.logger.child({ module: "provider-usage-service" });
    this.fetchers =
      options.fetchers ??
      createProviderUsageFetchers({
        logger: this.logger,
        fetch: options.fetch,
      });
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async listUsage(options?: { forceRefresh?: boolean }): Promise<ProviderUsageListResult> {
    const nowMs = this.now();
    const forceRefresh = options?.forceRefresh === true;
    if (!forceRefresh && this.cached && nowMs - this.cached.fetchedAtMs < this.cacheTtlMs) {
      return this.cached.result;
    }

    if (
      this.inFlight &&
      this.inFlight.generation === this.generation &&
      (!forceRefresh || this.inFlight.forceRefresh)
    ) {
      return this.inFlight.request;
    }

    const epoch = this.latestEpoch + 1;
    this.latestEpoch = epoch;
    const inFlight: ProviderUsageInFlight = {
      request: this.fetchFreshUsage({
        nowMs,
        generation: this.generation,
        epoch,
      }),
      generation: this.generation,
      epoch,
      forceRefresh,
    };
    this.inFlight = inFlight;
    try {
      return await inFlight.request;
    } finally {
      if (this.inFlight === inFlight) {
        this.inFlight = null;
      }
    }
  }

  async resetQuota(providerId: string): Promise<ProviderUsageResetQuotaResult> {
    const fetcher = this.fetchers.find((candidate) => candidate.providerId === providerId);
    if (!fetcher) {
      throw new Error(`Provider usage fetcher not found: ${providerId}`);
    }
    if (!fetcher.resetQuota) {
      throw new Error(`Provider does not support quota reset: ${providerId}`);
    }

    const result = await fetcher.resetQuota();
    this.generation += 1;
    this.cached = null;
    return result;
  }

  private async fetchFreshUsage(input: {
    nowMs: number;
    generation: number;
    epoch: number;
  }): Promise<ProviderUsageListResult> {
    const settled = await Promise.allSettled(this.fetchers.map((fetcher) => fetcher.fetchUsage()));
    const providers = settled.map((result, index) => {
      const fetcher = this.fetchers[index];
      if (result.status === "fulfilled") {
        return result.value;
      }
      this.logger.debug(
        { err: result.reason, providerId: fetcher.providerId },
        "Provider usage fetch failed",
      );
      return unavailableUsage({
        providerId: fetcher.providerId,
        displayName: fetcher.displayName,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });

    const result = { fetchedAt: new Date(input.nowMs).toISOString(), providers };
    if (this.generation === input.generation && this.latestEpoch === input.epoch) {
      this.cached = { fetchedAtMs: input.nowMs, result };
    }
    return result;
  }
}
