import type { ChildReportExpiredCachePolicy } from "@getpaseo/protocol/agent-cache-warm";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { resolveAgentPromptCacheExpiresAtMs } from "./prompt-cache-expiry.js";
import type { RuntimeStopRule } from "./idle-runtime-cleanup/index.js";

/** Rechecks a held report this often, for agents only on disk and for a changed host setting. */
const RECHECK_MS = 60_000;

export interface ChildReportHoldDependencies {
  /** Host setting `childReportExpiredCache`, read on every check so a change applies at once. */
  policy(): ChildReportExpiredCachePolicy;
  agentManager: Pick<AgentManager, "getAgent" | "hasInFlightRun" | "subscribe">;
  agentStorage: Pick<AgentStorage, "get">;
  now?: () => number;
  recheckMs?: number;
}

export interface ChildReportHold {
  /**
   * Resolves once a child's report may reach the orchestrator. With the hold policy, a report to an
   * idle orchestrator whose cache has expired waits for its next turn and steers into it, so the
   * report never wakes it. The cold process is stopped (`pendingReportsKeepRuntime`), so that turn
   * is usually a person's message. True when it held the report.
   */
  untilDeliverable(callerAgentId: string, signal: AbortSignal): Promise<boolean>;
}

/**
 * Whether a caller's pending child reports keep its runtime resident against this stop rule. A held
 * report is durable and waits for the next turn, so under hold it must not keep a cold process
 * alive, where Claude's own timers could start an unattended turn it would then ride into.
 */
export function pendingReportsKeepRuntime(
  rule: RuntimeStopRule,
  policy: ChildReportExpiredCachePolicy,
): boolean {
  return !(rule === "cache-expired" && policy === "hold");
}

export function createChildReportHold(deps: ChildReportHoldDependencies): ChildReportHold {
  const now = deps.now ?? (() => Date.now());
  const recheckMs = deps.recheckMs ?? RECHECK_MS;

  async function mustHold(agentId: string): Promise<boolean> {
    if (deps.policy() !== "hold") return false;
    if (deps.agentManager.hasInFlightRun(agentId)) return false;
    const live = deps.agentManager.getAgent(agentId);
    if (live?.lifecycle === "running") return false;
    const agent = live ?? (await deps.agentStorage.get(agentId));
    if (!agent) return false;
    const expiresAt = resolveAgentPromptCacheExpiresAtMs(agent);
    return expiresAt !== null && now() >= expiresAt;
  }

  function nextChange(agentId: string, signal: AbortSignal): Promise<void> {
    const stop = new AbortController();
    const changed = new Promise<void>((resolve) => {
      stop.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    const timer = setTimeout(() => stop.abort(), recheckMs);
    const unsubscribe = deps.agentManager.subscribe(
      (event) => {
        if (event.type === "agent_state") stop.abort();
      },
      { agentId, replayState: false },
    );
    const onAbort = () => stop.abort();
    if (signal.aborted) stop.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return changed.finally(() => {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
    });
  }

  return {
    async untilDeliverable(callerAgentId, signal) {
      let held = false;
      while (!signal.aborted && (await mustHold(callerAgentId))) {
        held = true;
        await nextChange(callerAgentId, signal);
      }
      return held;
    },
  };
}
