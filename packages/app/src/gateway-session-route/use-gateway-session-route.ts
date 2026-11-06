import type { GatewaySessionRouteGetResponseMessage } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

type GatewaySessionRoutePayload = GatewaySessionRouteGetResponseMessage["payload"];

/** Matches the daemon's cache; the read happens only while the meter details are open. */
export const GATEWAY_SESSION_ROUTE_STALE_TIME_MS = 15_000;

export function gatewaySessionRouteQueryKey(
  serverId: string | null | undefined,
  agentId: string | null | undefined,
) {
  return ["gatewaySessionRoute", serverId ?? "", agentId ?? ""] as const;
}

/**
 * The route to show, or null when the host has none: an agent that is not
 * CLIProxyAPI-routed, a session the Gateway has not served, or a Gateway build
 * without the route. The section hides rather than showing an error.
 */
export function pickGatewaySessionRoute(
  payload: GatewaySessionRoutePayload | undefined,
): GatewaySessionRoutePayload["route"] {
  return payload?.supported ? payload.route : null;
}

/** The CLIProxyAPI account serving the agent's session. */
export function useGatewaySessionRoute(
  serverId: string | null | undefined,
  agentId: string | null | undefined,
): GatewaySessionRoutePayload["route"] {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supported = useHostFeature(serverId, "cliproxyapiSessionRoute");
  const canFetch = Boolean(client && isConnected && supported && agentId);

  const query = useFetchQuery<GatewaySessionRoutePayload, Error>({
    queryKey: gatewaySessionRouteQueryKey(serverId, agentId),
    queryFn: () => {
      if (!client || !agentId) {
        throw new Error("Host connection is not ready");
      }
      return client.getGatewaySessionRoute({ agentId });
    },
    enabled: canFetch,
    retry: false,
    dataShape: "value",
    staleTimeMs: GATEWAY_SESSION_ROUTE_STALE_TIME_MS,
  });
  return pickGatewaySessionRoute(query.data);
}
