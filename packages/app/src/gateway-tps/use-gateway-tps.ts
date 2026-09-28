import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { GatewayTpsGetResponseMessage } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

type GatewayTpsClient = Pick<DaemonClient, "getGatewayTps">;
type GatewayTpsPayload = GatewayTpsGetResponseMessage["payload"];

/**
 * Zero, not a window: the figure describes the last request that model served,
 * so a cached one is wrong rather than merely old, and the caller refetches on
 * every open.
 */
export const GATEWAY_TPS_STALE_TIME_MS = 0;

export function gatewayTpsQueryKey(
  serverId: string | null | undefined,
  provider: string | null | undefined,
  model: string | null | undefined,
) {
  return ["gatewayTps", serverId ?? "", provider ?? "", model ?? ""] as const;
}

interface GatewayTpsReadiness {
  client: GatewayTpsClient | null | undefined;
  isConnected: boolean;
  supportsGatewayTps: boolean;
  provider: string | null | undefined;
  model: string | null | undefined;
}

/**
 * The read is scoped to a tooltip hover, so it needs a connected host that
 * advertises the capability and a model the Gateway can resolve. There is no
 * retained-panel gate: the caller only fetches while the tooltip is open, which
 * is a stricter condition than "on screen".
 */
export function canFetchGatewayTps(readiness: GatewayTpsReadiness): boolean {
  return (
    Boolean(readiness.client) &&
    readiness.isConnected &&
    readiness.supportsGatewayTps &&
    Boolean(readiness.provider) &&
    Boolean(readiness.model)
  );
}

/**
 * The record to show, or null when the host has none: a Gateway build without
 * the route, a model that has not run, or a provider that is not
 * CLIProxyAPI-routed. The section hides rather than showing an error.
 */
export function pickGatewayTpsSample(
  payload: GatewayTpsPayload | undefined,
): GatewayTpsPayload["sample"] {
  return payload?.supported ? payload.sample : null;
}

/**
 * Throughput for the selected model, read only while the context-meter tooltip
 * is open. Every open refetches, so the figure is the rate of the most recent
 * request rather than something an interval kept warm. No polling: the Gateway
 * read does no upstream work, so there is nothing to gain from asking more
 * often than the user looks.
 */
export function useGatewayTps({
  serverId,
  provider,
  model,
  enabled,
}: {
  serverId: string | null | undefined;
  provider: string | null | undefined;
  model: string | null | undefined;
  enabled: boolean;
}): { sample: GatewayTpsPayload["sample"]; refresh: () => Promise<void> } {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsGatewayTps = useHostFeature(serverId, "cliproxyapiTps");

  const canFetch = canFetchGatewayTps({ client, isConnected, supportsGatewayTps, provider, model });
  const queryKey = gatewayTpsQueryKey(serverId, provider, model);

  const query = useFetchQuery<GatewayTpsPayload, Error>({
    queryKey,
    queryFn: () => {
      if (!client || !provider || !model) {
        throw new Error("Host connection is not ready");
      }
      return client.getGatewayTps({ provider, model });
    },
    enabled: enabled && canFetch,
    retry: false,
    dataShape: "value",
    staleTimeMs: GATEWAY_TPS_STALE_TIME_MS,
  });

  const refresh = useCallback(async () => {
    if (!canFetch) {
      return;
    }
    await queryClient.fetchQuery<GatewayTpsPayload>({
      queryKey,
      queryFn: async () => {
        if (!client || !provider || !model) {
          throw new Error("Host connection is not ready");
        }
        return client.getGatewayTps({ provider, model });
      },
      staleTime: GATEWAY_TPS_STALE_TIME_MS,
    });
  }, [canFetch, client, model, provider, queryClient, queryKey]);

  return { sample: pickGatewayTpsSample(query.data), refresh };
}
