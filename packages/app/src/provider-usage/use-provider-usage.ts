import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { providerUsageCopy } from "./copy";
import type {
  ProviderUsageListPayload,
  ProviderUsageResetQuotaPayload,
  ProviderUsageView,
} from "./types";

export const PROVIDER_USAGE_STALE_TIME_MS = 5 * 60 * 1000;

type ProviderUsageClient = Pick<DaemonClient, "listProviderUsage" | "resetProviderUsageQuota">;
type ProviderUsageQueryKey = ReturnType<typeof providerUsageQueryKey>;
interface ProviderUsageRefreshOptions {
  forceRefresh?: boolean;
}

export function providerUsageQueryKey(serverId: string | null | undefined) {
  return ["providerUsage", serverId ?? ""] as const;
}

async function fetchProviderUsage(
  client: ProviderUsageClient,
  options: ProviderUsageRefreshOptions = {},
): Promise<ProviderUsageListPayload> {
  return client.listProviderUsage({ forceRefresh: options.forceRefresh });
}

export async function refetchProviderUsageAfterReset(input: {
  queryClient: QueryClient;
  queryKey: ProviderUsageQueryKey;
  client: ProviderUsageClient | null;
  canFetch: boolean;
  canForceRefreshQuota: boolean;
}): Promise<void> {
  await input.queryClient.invalidateQueries({ queryKey: input.queryKey, refetchType: "none" });
  const client = input.client;
  if (!input.canFetch || !client) {
    return;
  }

  try {
    await input.queryClient.fetchQuery({
      queryKey: input.queryKey,
      queryFn: async () =>
        fetchProviderUsage(client, {
          forceRefresh: input.canForceRefreshQuota,
        }),
      staleTime: 0,
    });
  } catch {
    await input.queryClient.invalidateQueries({ queryKey: input.queryKey, refetchType: "none" });
  }
}

interface UseProviderUsageOptions {
  enabled?: boolean;
}

export function useProviderUsage(
  serverId: string | null | undefined,
  options: UseProviderUsageOptions = {},
): {
  view: ProviderUsageView;
  refresh: (options?: ProviderUsageRefreshOptions) => Promise<void>;
  resetQuota: (providerId: string) => Promise<ProviderUsageResetQuotaPayload>;
  canFetch: boolean;
  canResetQuota: boolean;
  canForceRefreshQuota: boolean;
  resettingProviderId: string | null;
} {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsProviderUsage = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.providerUsageList === true,
  );
  const supportsProviderUsageResetQuota = useSessionStore(
    (state) =>
      state.sessions[serverId ?? ""]?.serverInfo?.features?.providerUsageResetQuota === true,
  );
  const supportsProviderUsageForceRefresh = useSessionStore(
    (state) =>
      state.sessions[serverId ?? ""]?.serverInfo?.features?.providerUsageForceRefresh === true,
  );
  const queryKey = useMemo(() => providerUsageQueryKey(serverId), [serverId]);
  const canFetch = Boolean(serverId && client && isConnected && supportsProviderUsage);
  const canResetQuota = Boolean(canFetch && supportsProviderUsageResetQuota);
  const canForceRefreshQuota = Boolean(canFetch && supportsProviderUsageForceRefresh);
  const enabled = Boolean((options.enabled ?? true) && canFetch);

  const queryFn = useCallback(async () => {
    if (!client) {
      throw new Error(providerUsageCopy.clientUnavailable);
    }
    return fetchProviderUsage(client);
  }, [client]);

  const query = useQuery({
    queryKey,
    queryFn,
    enabled,
    staleTime: PROVIDER_USAGE_STALE_TIME_MS,
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  const resetQuotaMutation = useMutation({
    mutationFn: async (providerId: string) => {
      if (!client || !canResetQuota) {
        throw new Error(providerUsageCopy.clientUnavailable);
      }
      return client.resetProviderUsageQuota({ providerId });
    },
  });
  const {
    mutateAsync: resetQuotaAsync,
    isPending: isResetQuotaPending,
    variables: resettingProviderId,
  } = resetQuotaMutation;

  const refresh = useCallback(
    async (refreshOptions: ProviderUsageRefreshOptions = {}) => {
      await queryClient.invalidateQueries({ queryKey, refetchType: "none" });
      if (!canFetch) {
        return;
      }
      const shouldForceRefresh = refreshOptions.forceRefresh === true && canForceRefreshQuota;
      await queryClient.fetchQuery({
        queryKey,
        queryFn: async () => {
          if (!client) {
            throw new Error(providerUsageCopy.clientUnavailable);
          }
          return fetchProviderUsage(client, { forceRefresh: shouldForceRefresh });
        },
        staleTime: 0,
      });
    },
    [canFetch, canForceRefreshQuota, client, queryClient, queryKey],
  );

  const resetQuota = useCallback(
    async (providerId: string) => {
      const result = await resetQuotaAsync(providerId);
      await refetchProviderUsageAfterReset({
        queryClient,
        queryKey,
        client,
        canFetch,
        canForceRefreshQuota,
      });
      return result;
    },
    [canFetch, canForceRefreshQuota, client, queryClient, queryKey, resetQuotaAsync],
  );

  const view = useMemo<ProviderUsageView>(() => {
    if (!serverId || !client || !isConnected) {
      return { kind: "error", message: providerUsageCopy.hostUnavailable };
    }
    if (!supportsProviderUsage) {
      return { kind: "error", message: providerUsageCopy.hostUpgradeRequired };
    }
    if (query.data) {
      return {
        kind: "ready",
        payload: query.data,
        isRefreshing: query.isFetching,
      };
    }
    if (query.isError) {
      return {
        kind: "error",
        message: query.error instanceof Error ? query.error.message : String(query.error),
      };
    }
    return { kind: "loading" };
  }, [
    client,
    isConnected,
    query.data,
    query.error,
    query.isError,
    query.isFetching,
    serverId,
    supportsProviderUsage,
  ]);

  return {
    view,
    refresh,
    resetQuota,
    canFetch,
    canResetQuota,
    canForceRefreshQuota,
    resettingProviderId: isResetQuotaPending ? (resettingProviderId ?? null) : null,
  };
}
