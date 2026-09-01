import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ProviderUsageListPayload } from "./types";
import { providerUsageQueryKey, refetchProviderUsageAfterReset } from "./use-provider-usage";

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function usagePayload(usedPct: number): ProviderUsageListPayload {
  return {
    requestId: "usage-1",
    fetchedAt: "2026-06-19T00:00:00.000Z",
    providers: [
      {
        providerId: "codex",
        displayName: "Codex",
        status: "available",
        planLabel: "Pro",
        windows: [{ id: "weekly", label: "Weekly", usedPct }],
      },
    ],
  };
}

describe("refetchProviderUsageAfterReset", () => {
  it("keeps existing usage data when the post-reset refetch fails", async () => {
    const queryClient = createQueryClient();
    const queryKey = providerUsageQueryKey("server-1");
    const existingUsage = usagePayload(29);
    queryClient.setQueryData(queryKey, existingUsage);
    const client = {
      listProviderUsage: vi.fn(async () => {
        throw new Error("usage refresh failed after reset");
      }),
      resetProviderUsageQuota: vi.fn(),
    };

    await expect(
      refetchProviderUsageAfterReset({
        queryClient,
        queryKey,
        client,
        canFetch: true,
        canForceRefreshQuota: true,
      }),
    ).resolves.toBeUndefined();

    expect(client.listProviderUsage).toHaveBeenCalledWith({ forceRefresh: true });
    expect(queryClient.getQueryData(queryKey)).toEqual(existingUsage);
  });
});
