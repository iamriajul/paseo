// Records which CLIProxyAPI account serves each agent's session, and when it switches.
//
// The Gateway keeps each session's switch history; the daemon reads it once per finished turn —
// never on a timer — so an idle agent costs nothing and a failover that happened mid-turn is
// recorded as soon as the turn ends. Changes are saved on the agent, so the timeline can name
// the account above each prompt it served and cache insights can name the switch behind a miss.
import type { Logger } from "pino";
import {
  FIVE_MINUTE_CACHE_WINDOW_MS,
  findGatewaySwitchMiss,
  resolveEffectivePromptCacheWindows,
  type GatewayAccountChange,
  type PromptCacheHistoryEntry,
} from "@getpaseo/protocol/agent-cache-warm";
import { CLAUDE_PROMPT_CACHE_TTL_FEATURE_ID } from "../providers/claude/feature-definitions.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentProvider } from "../agent-sdk-types.js";
import {
  fetchGatewaySessionRoute,
  gatewayRoutedSessionId,
  gatewaySessionIdFor,
  type GatewayRouteAccount,
  type GatewayRouteSwitch,
  type GatewaySessionRoute,
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
  agentManager: Pick<
    AgentManager,
    "subscribe" | "getAgent" | "recordGatewayAccountChange" | "readPromptCacheHistory"
  >;
  gateway: () => GatewayEndpoint | null | undefined;
  isGatewayRouted: (provider: AgentProvider, model: string | null | undefined) => boolean;
  fetchRoute?: (options: {
    baseUrl: string;
    token: string;
    session: string;
  }) => Promise<GatewaySessionRouteResult>;
  settleMs?: number;
}

/** The change a session makes when `account` starts serving it at `at`. */
function changeTo(at: string, account: GatewayRouteAccount): GatewayAccountChange {
  const change: GatewayAccountChange = { at, account: account.label };
  if (account.plan) change.plan = account.plan;
  return change;
}

/** The change a Gateway switch records: the new account, the one it left, and why. */
function changeFromSwitch(entry: GatewayRouteSwitch): GatewayAccountChange {
  const change = changeTo(entry.at, entry.to);
  change.from = entry.from.label;
  change.reason = entry.reason;
  if (entry.statusCode) change.statusCode = entry.statusCode;
  return change;
}

/**
 * Account changes the route shows that are not recorded yet. The first observation records the
 * serving account; later ones record each newer switch. When the Gateway no longer has the switch
 * (its history is short and expires) but the account differs, the change is recorded without a
 * reason.
 *
 * `agentCreatedAt` bounds the first observation: a native fork looks up its root session's route,
 * whose account may have been serving since long before the fork existed. Its first record then
 * starts at the fork's creation, so the timeline names the account above the fork's own first
 * prompt, and a switch from before the fork is not presented as the fork's.
 */
export function nextGatewayAccountChanges(
  route: GatewaySessionRoute,
  last: GatewayAccountChange | undefined,
  agentCreatedAt?: string,
): GatewayAccountChange[] {
  if (!last) {
    const createdMs = agentCreatedAt ? Date.parse(agentCreatedAt) : Number.NaN;
    if (Number.isFinite(createdMs) && Date.parse(route.since) < createdMs) {
      return [changeTo(new Date(createdMs).toISOString(), route.account)];
    }
    // The switch that brought the session to its current account, when the Gateway still has it.
    const latest = route.switches.at(-1);
    return [
      latest && latest.at === route.since
        ? changeFromSwitch(latest)
        : changeTo(route.since, route.account),
    ];
  }
  const lastMs = Date.parse(last.at);
  const switches = route.switches.filter((entry) => Date.parse(entry.at) > lastMs);
  if (switches.length > 0) {
    return switches.map(changeFromSwitch);
  }
  if (route.account.label !== last.account && Date.parse(route.since) > lastMs) {
    const change = changeTo(route.since, route.account);
    change.from = last.account;
    return [change];
  }
  return [];
}

export function attachGatewaySessionRouteWatcher(deps: GatewaySessionRouteWatcherDeps): () => void {
  const fetchRoute = deps.fetchRoute ?? fetchGatewaySessionRoute;
  const settleMs = deps.settleMs ?? GATEWAY_SWITCH_SETTLE_MS;
  // One check at a time per agent, so two quick turns never record a change twice.
  const pending = new Map<string, Promise<void>>();

  /** The snapshot window when it reaches back to the switch, else the whole journal. */
  async function requestsSince(agentId: string, at: string): Promise<PromptCacheHistoryEntry[]> {
    const window = deps.agentManager.getAgent(agentId)?.promptCache?.history ?? [];
    const first = window[0];
    if (first && Date.parse(first.at) <= Date.parse(at)) return window;
    return (await deps.agentManager.readPromptCacheHistory(agentId)).requests;
  }

  async function check(agentId: string): Promise<void> {
    const agent = deps.agentManager.getAgent(agentId);
    if (!agent || agent.internal) return;
    const gateway = deps.gateway();
    if (!gateway || !deps.isGatewayRouted(agent.provider, agent.config.model)) return;
    const session = gatewaySessionIdFor(agent.provider, gatewayRoutedSessionId(agent));
    if (!session) return;

    const { route } = await fetchRoute({
      baseUrl: gateway.baseUrl,
      token: gateway.apiKey,
      session,
    });
    if (!route) return;
    // The window the cache insights judge expiry by, so both name the same cause for a miss.
    const cacheWindowMs =
      resolveEffectivePromptCacheWindows({
        observedTtl: agent.promptCache?.observedTtl,
        promptCacheTtl: agent.config.featureValues?.[CLAUDE_PROMPT_CACHE_TTL_FEATURE_ID],
      })?.cacheWindowMs ?? FIVE_MINUTE_CACHE_WINDOW_MS;
    const changes = nextGatewayAccountChanges(
      route,
      agent.gatewayAccounts?.at(-1),
      agent.createdAt.toISOString(),
    );
    for (const change of changes) {
      // A session's first account had no earlier cache on the Gateway to lose.
      const missAt = change.from
        ? findGatewaySwitchMiss(await requestsSince(agentId, change.at), change.at, cacheWindowMs)
        : undefined;
      deps.agentManager.recordGatewayAccountChange(
        agentId,
        missAt ? { ...change, missAt } : change,
      );
    }
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
      if (event.type !== "agent_stream") return;
      if (event.event.type !== "turn_completed" && event.event.type !== "turn_failed") return;
      schedule(event.agentId);
    },
    { replayState: false },
  );
}
