import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { GatewayStatsGetResponseMessage } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

type GatewayStatsClient = Pick<DaemonClient, "getGatewayStats">;
type GatewayStatsPayload = GatewayStatsGetResponseMessage["payload"];

/**
 * Polled while the tooltip is open so someone watching throughput sees it move
 * rather than getting one frozen number. Three seconds is a deliberate floor,
 * not a ceiling: below it the readings stop being about a request and start
 * being about the poll, and each tick is a WebSocket round trip on the client
 * that has to render it. The Gateway read is in-process history — it makes no
 * upstream call — so the cost is ours, not the provider's.
 */
export const GATEWAY_STATS_POLL_MS = 3_000;

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
 * Throughput for the selected model, polled only while the context-meter
 * tooltip is open. Closing the tooltip stops the interval with it, so a
 * background or idle session costs nothing.
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
}): {
  sample: GatewayStatsPayload["sample"];
  /** True while a poll is in flight or has landed recently — the live dot. */
  isLive: boolean;
} {
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

  const query = useFetchQuery<GatewayStatsPayload, Error>({
    queryKey: gatewayStatsQueryKey(serverId, provider, model),
    queryFn: () => {
      if (!client || !provider || !model) {
        throw new Error("Host connection is not ready");
      }
      return client.getGatewayStats({ provider, model });
    },
    enabled: enabled && canFetch,
    retry: false,
    dataShape: "value",
    staleTimeMs: GATEWAY_STATS_POLL_MS,
    refetchInterval: GATEWAY_STATS_POLL_MS,
  });

  return { sample: pickGatewayStatsSample(query.data), isLive: enabled && canFetch };
}
