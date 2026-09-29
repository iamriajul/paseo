import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { GatewayStatsGetResponseMessage } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

type GatewayStatsClient = Pick<DaemonClient, "getGatewayStats">;
type GatewayStatsPayload = GatewayStatsGetResponseMessage["payload"];

/**
 * Zero, not a window: the figure describes the last request that model served,
 * so a cached one is wrong rather than merely old, and the caller refetches on
 * every open.
 */
export const GATEWAY_STATS_STALE_TIME_MS = 0;

export function gatewayStatsQueryKey(
  serverId: string | null | undefined,
  provider: string | null | undefined,
  model: string | null | undefined,
) {
  return ["gatewayStats", serverId ?? "", provider ?? "", model ?? ""] as const;
}

interface GatewayStatsReadiness {
  client: GatewayStatsClient | null | undefined;
  isConnected: boolean;
  supportsGatewayStats: boolean;
  provider: string | null | undefined;
  model: string | null | undefined;
}

/**
 * The read is scoped to a tooltip hover, so it needs a connected host that
 * advertises the capability and a model the Gateway can resolve. There is no
 * retained-panel gate: the caller only fetches while the tooltip is open, which
 * is a stricter condition than "on screen".
 */
export function canFetchGatewayStats(readiness: GatewayStatsReadiness): boolean {
  return (
    Boolean(readiness.client) &&
    readiness.isConnected &&
    readiness.supportsGatewayStats &&
    Boolean(readiness.provider) &&
    Boolean(readiness.model)
  );
}

/**
 * The record to show, or null when the host has none: a Gateway build without
 * the route, a model that has not run, or a provider that is not
 * CLIProxyAPI-routed. The section hides rather than showing an error.
 */
export function pickGatewayStatsSample(
  payload: GatewayStatsPayload | undefined,
): GatewayStatsPayload["sample"] {
  return payload?.supported ? payload.sample : null;
}

/**
 * Throughput for the selected model, read only while the context-meter tooltip
 * is open. Every open refetches, so the figure is the rate of the most recent
 * request rather than something an interval kept warm. No polling: the Gateway
 * read does no upstream work, so there is nothing to gain from asking more
 * often than the user looks.
 */
export function useGatewayStats({
  serverId,
  provider,
  model,
  enabled,
}: {
  serverId: string | null | undefined;
  provider: string | null | undefined;
  model: string | null | undefined;
  enabled: boolean;
}): { sample: GatewayStatsPayload["sample"]; refresh: () => Promise<void> } {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsGatewayStats = useHostFeature(serverId, "cliproxyapiStats");

  const canFetch = canFetchGatewayStats({
    client,
    isConnected,
    supportsGatewayStats,
    provider,
    model,
  });
  const queryKey = gatewayStatsQueryKey(serverId, provider, model);

  const query = useFetchQuery<GatewayStatsPayload, Error>({
    queryKey,
    queryFn: () => {
      if (!client || !provider || !model) {
        throw new Error("Host connection is not ready");
      }
      return client.getGatewayStats({ provider, model });
    },
    enabled: enabled && canFetch,
    retry: false,
    dataShape: "value",
    staleTimeMs: GATEWAY_STATS_STALE_TIME_MS,
  });

  const refresh = useCallback(async () => {
    if (!canFetch) {
      return;
    }
    await queryClient.fetchQuery<GatewayStatsPayload>({
      queryKey,
      queryFn: async () => {
        if (!client || !provider || !model) {
          throw new Error("Host connection is not ready");
        }
        return client.getGatewayStats({ provider, model });
      },
      staleTime: GATEWAY_STATS_STALE_TIME_MS,
    });
  }, [canFetch, client, model, provider, queryClient, queryKey]);

  return { sample: pickGatewayStatsSample(query.data), refresh };
}
