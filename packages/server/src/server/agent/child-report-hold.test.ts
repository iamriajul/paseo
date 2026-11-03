import { describe, expect, it } from "vitest";
import type { ChildReportExpiredCachePolicy } from "@getpaseo/protocol/agent-cache-warm";
import type { AgentManager, AgentSubscriber, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { createChildReportHold, pendingReportsKeepRuntime } from "./child-report-hold.js";

const MINUTE = 60_000;
const START = new Date("2026-11-03T10:00:00.000Z").getTime();

function orchestrator(lifecycle: ManagedAgent["lifecycle"], lastRequestMs: number): ManagedAgent {
  return {
    id: "orchestrator",
    provider: "claude",
    lifecycle,
    config: { model: "claude-opus-5-5", featureValues: { prompt_cache_ttl: "5m" } },
    promptCache: { lastRequest: { at: new Date(lastRequestMs).toISOString() } },
  } as unknown as ManagedAgent;
}

function harness(input: { policy: ChildReportExpiredCachePolicy; agent: ManagedAgent }) {
  let agent = input.agent;
  let nowMs = START + 6 * MINUTE;
  const subscribers = new Set<AgentSubscriber>();
  const hold = createChildReportHold({
    policy: () => input.policy,
    agentManager: {
      getAgent: () => agent,
      hasInFlightRun: () => false,
      subscribe: (callback: AgentSubscriber) => {
        subscribers.add(callback);
        return () => subscribers.delete(callback);
      },
    } as unknown as AgentManager,
    agentStorage: { get: async () => null } as unknown as AgentStorage,
    now: () => nowMs,
    recheckMs: 10 * MINUTE,
  });
  return {
    hold,
    /** A person sends the orchestrator a message: its turn starts and writes its cache again. */
    startTurn() {
      nowMs += MINUTE;
      agent = orchestrator("running", nowMs);
      for (const subscriber of subscribers) subscriber({ type: "agent_state", agent });
    },
  };
}

async function settled(promise: Promise<boolean>): Promise<boolean | "pending"> {
  return Promise.race([promise, new Promise<"pending">((r) => setTimeout(() => r("pending"), 20))]);
}

describe("child report hold", () => {
  it("holds a report to an idle orchestrator whose cache expired until its next turn", async () => {
    const { hold, startTurn } = harness({ policy: "hold", agent: orchestrator("idle", START) });
    const delivery = hold.untilDeliverable("orchestrator", new AbortController().signal);

    expect(await settled(delivery)).toBe("pending");
    startTurn();
    expect(await settled(delivery)).toBe(true);
  });

  it("delivers at once while the orchestrator's cache is still warm", async () => {
    const warm = orchestrator("idle", START + 3 * MINUTE);
    const { hold } = harness({ policy: "hold", agent: warm });
    expect(await settled(hold.untilDeliverable("orchestrator", new AbortController().signal))).toBe(
      false,
    );
  });

  it("delivers at once with the wake policy, even to an expired cache", async () => {
    const { hold } = harness({ policy: "wake", agent: orchestrator("idle", START) });
    expect(await settled(hold.untilDeliverable("orchestrator", new AbortController().signal))).toBe(
      false,
    );
  });

  it("stops holding when the subscription is aborted", async () => {
    const { hold } = harness({ policy: "hold", agent: orchestrator("idle", START) });
    const controller = new AbortController();
    const delivery = hold.untilDeliverable("orchestrator", controller.signal);
    controller.abort();
    expect(await settled(delivery)).toBe(true);
  });
});

describe("pending reports and the runtime sweep", () => {
  it("lets an expired cache stop the orchestrator while a report is held", () => {
    expect(pendingReportsKeepRuntime("cache-expired", "hold")).toBe(false);
  });

  it("keeps the orchestrator resident for idle stops and for the other policies", () => {
    expect(pendingReportsKeepRuntime("idle", "hold")).toBe(true);
    expect(pendingReportsKeepRuntime("cache-expired", "wake")).toBe(true);
    expect(pendingReportsKeepRuntime("cache-expired", "keep-warm")).toBe(true);
  });
});
