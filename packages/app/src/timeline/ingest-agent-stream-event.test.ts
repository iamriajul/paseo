import { describe, expect, it } from "vitest";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { AgentStreamReducerEvent } from "./session-stream-reducers";
import {
  flushPendingSubmissionsBeforeClearingLiveness,
  ingestAgentStreamEvent,
  isUserMessageStreamEvent,
} from "./ingest-agent-stream-event";

function streamEvent(event: AgentStreamEventPayload): AgentStreamReducerEvent {
  return { event, seq: 1, epoch: "epoch-1", timestamp: new Date("2026-09-01T00:00:00.000Z") };
}

describe("ingestAgentStreamEvent", () => {
  it("flushes a live user_message instead of waiting for the coalescer frame", () => {
    const flushed: string[] = [];
    ingestAgentStreamEvent({
      enqueue: () => undefined,
      flushAgent: (agentId) => {
        flushed.push(agentId);
      },
      agentId: "agent-1",
      event: streamEvent({
        type: "timeline",
        provider: "mock",
        item: { type: "user_message", text: "Settle this provider-acknowledged submission." },
      }),
    });
    expect(flushed).toEqual(["agent-1"]);
  });

  it("does not flush assistant deltas immediately", () => {
    const flushed: string[] = [];
    ingestAgentStreamEvent({
      enqueue: () => undefined,
      flushAgent: (agentId) => {
        flushed.push(agentId);
      },
      agentId: "agent-1",
      event: streamEvent({
        type: "timeline",
        provider: "mock",
        item: { type: "assistant_message", text: "Cycle 1" },
      }),
    });
    expect(flushed).toEqual([]);
  });

  it("flushes pending submissions before clearing turn liveness on drop", () => {
    const order: string[] = [];
    flushPendingSubmissionsBeforeClearingLiveness({
      flushAgent: (agentId) => {
        order.push(`flush:${agentId}`);
      },
      pendingAgentIds: ["agent-1"],
      clearTurnLiveness: () => {
        order.push("clear");
      },
    });
    expect(order).toEqual(["flush:agent-1", "clear"]);
  });
});

describe("isUserMessageStreamEvent", () => {
  it("matches timeline user_message events only", () => {
    expect(
      isUserMessageStreamEvent({
        type: "timeline",
        provider: "mock",
        item: { type: "user_message", text: "hi" },
      }),
    ).toBe(true);
    expect(
      isUserMessageStreamEvent({
        type: "turn_started",
        provider: "mock",
        turnId: "turn-1",
      }),
    ).toBe(false);
  });
});
