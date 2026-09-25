import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { gatewayQuotaCopy } from "./copy";
import type { GatewayQuotaPayload, GatewayQuotaView } from "./types";

export const GATEWAY_QUOTA_STALE_TIME_MS = 60 * 1000;

type GatewayQuotaClient = Pick<DaemonClient, "getGatewayQuota">;

export function gatewayQuotaQueryKey(
  serverId: string | null | undefined,
  provider: string | null | undefined,
  model: string | null | undefined,
) {
  return ["gatewayQuota", serverId ?? "", provider ?? "", model ?? ""] as const;
}

async function fetchGatewayQuota(
  client: GatewayQuotaClient,
  provider: string,
  model: string,
): Promise<GatewayQuotaPayload> {
  return client.getGatewayQuota({ provider, model });
}

interface UseGatewayQuotaOptions {
  enabled?: boolean;
}

export function useGatewayQuota(
  serverId: string | null | undefined,
  provider: string | null | undefined,
  model: string | null | undefined,
  options: UseGatewayQuotaOptions = {},
): {
  view: GatewayQuotaView;
  refresh: () => Promise<void>;
} {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsGatewayQuota = useHostFeature(serverId, "gatewayQuota");
  const queryKey = useMemo(
    () => gatewayQuotaQueryKey(serverId, provider, model),
    [serverId, provider, model],
  );
  const canFetch = Boolean(
    serverId && client && isConnected && supportsGatewayQuota && provider && model,
  );
  const enabled = Boolean((options.enabled ?? true) && canFetch);

  const query = useFetchQuery<GatewayQuotaPayload, Error>({
    queryKey,
    queryFn: () => {
      if (!client || !provider || !model) {
        throw new Error(gatewayQuotaCopy.clientUnavailable);
      }
      return fetchGatewayQuota(client, provider, model);
    },
    enabled,
    retry: false,
    dataShape: "value",
    staleTimeMs: GATEWAY_QUOTA_STALE_TIME_MS,
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey, refetchType: "none" });
    if (!canFetch) {
      return;
    }
    await queryClient.fetchQuery({
      queryKey,
      queryFn: async (): Promise<GatewayQuotaPayload> => {
        if (!client || !provider || !model) {
          throw new Error(gatewayQuotaCopy.clientUnavailable);
        }
        return fetchGatewayQuota(client, provider, model);
      },
      staleTime: 0,
    });
  }, [canFetch, client, model, provider, queryClient, queryKey]);

  const view = useMemo<GatewayQuotaView>(() => {
    if (!serverId || !client || !isConnected) {
      return { kind: "error", message: gatewayQuotaCopy.hostUnavailable };
    }
    if (!supportsGatewayQuota) {
      return { kind: "error", message: gatewayQuotaCopy.hostUpgradeRequired };
    }
    if (!provider || !model) {
      return { kind: "error", message: gatewayQuotaCopy.missingContext };
    }
    if (query.data) {
      return { kind: "ready", payload: query.data };
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
    model,
    provider,
    query.data,
    query.error,
    query.isError,
    serverId,
    supportsGatewayQuota,
  ]);

  return { view, refresh };
}
