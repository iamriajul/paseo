// Announces CLIProxyAPI account switches in an agent's timeline.
//
// The Gateway keeps each session's switch history; the daemon reads it once per
// finished turn — never on a timer — so an idle agent costs nothing and a
// failover that happened mid-turn shows up as soon as the turn ends. Switches
// older than this daemon process are not announced: after a restart the daemon
// cannot tell which of them a previous process already wrote.
import type { Logger } from "pino";
import type { AgentManager } from "../agent-manager.js";
import type { AgentProvider } from "../agent-sdk-types.js";
import {
  describeGatewaySwitch,
  fetchGatewaySessionRoute,
  gatewaySessionIdFor,
  type GatewaySessionRouteResult,
} from "./session-route.js";

/**
 * The Gateway records a request on its usage bus asynchronously, so a read right
 * at turn end can miss the failover that happened in that turn's last request.
 */
export const GATEWAY_SWITCH_SETTLE_MS = 2_000;

interface GatewayEndpoint {
  baseUrl: string;
  apiKey: string;
}

export interface GatewaySessionRouteWatcherDeps {
  logger: Logger;
  agentManager: Pick<AgentManager, "subscribe" | "getAgent" | "appendTimelineItem">;
  gateway: () => GatewayEndpoint | null | undefined;
  isGatewayRouted: (provider: AgentProvider) => boolean;
  fetchRoute?: (options: {
    baseUrl: string;
    token: string;
    session: string;
  }) => Promise<GatewaySessionRouteResult>;
  now?: () => number;
  settleMs?: number;
}

export function attachGatewaySessionRouteWatcher(deps: GatewaySessionRouteWatcherDeps): () => void {
  const fetchRoute = deps.fetchRoute ?? fetchGatewaySessionRoute;
  const startedAt = (deps.now ?? Date.now)();
  const settleMs = deps.settleMs ?? GATEWAY_SWITCH_SETTLE_MS;
  // Newest switch time already announced, per agent.
  const announcedUntil = new Map<string, number>();
  // One check at a time per agent, so two quick turns never announce twice.
  const pending = new Map<string, Promise<void>>();

  async function check(agentId: string): Promise<void> {
    const agent = deps.agentManager.getAgent(agentId);
    if (!agent || agent.internal) return;
    const gateway = deps.gateway();
    if (!gateway || !deps.isGatewayRouted(agent.provider)) return;
    const session = gatewaySessionIdFor(agent.provider, agent.persistence?.sessionId);
    if (!session) return;

    const { route } = await fetchRoute({
      baseUrl: gateway.baseUrl,
      token: gateway.apiKey,
      session,
    });
    if (!route) return;
    const since = announcedUntil.get(agentId) ?? startedAt;
    let newest = since;
    for (const entry of route.switches) {
      const at = Date.parse(entry.at);
      if (!Number.isFinite(at) || at <= since) continue;
      await deps.agentManager.appendTimelineItem(agentId, {
        type: "notification",
        level: "info",
        message: describeGatewaySwitch(entry),
      });
      newest = Math.max(newest, at);
    }
    announcedUntil.set(agentId, newest);
  }

  function schedule(agentId: string): void {
    const previous = pending.get(agentId) ?? Promise.resolve();
    const next = previous
      .then(() => new Promise((resolve) => setTimeout(resolve, settleMs)))
      .then(() => check(agentId))
      .catch((error: unknown) => {
        deps.logger.warn({ err: error, agentId }, "Failed to check CLIProxyAPI session route");
      })
      .finally(() => {
        if (pending.get(agentId) === next) pending.delete(agentId);
      });
    pending.set(agentId, next);
  }

  return deps.agentManager.subscribe(
    (event) => {
      if (event.type === "agent_removed") {
        announcedUntil.delete(event.agentId);
        return;
      }
      if (event.type !== "agent_stream") return;
      if (event.event.type !== "turn_completed" && event.event.type !== "turn_failed") return;
      schedule(event.agentId);
    },
    { replayState: false },
  );
}
