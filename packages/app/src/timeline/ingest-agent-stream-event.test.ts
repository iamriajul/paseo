import { afterEach, describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import { getActiveMessageSubmissions } from "@/composer/submission/model";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import { createUserMessage, type UserMessageItem } from "@/types/stream";
import {
  createAgentStreamReducerQueue,
  processAgentStreamEvent,
  processAgentStreamEvents,
  type AgentStreamReducerEvent,
} from "./session-stream-reducers";
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

describe("live user_message acknowledgement", () => {
  const agentId = "agent-1";
  const clientMessageId = "msg_client";
  const prompt = "Settle this provider-acknowledged submission.";

  afterEach(() => {
    useSessionStore.getState().clearSession("test-server");
  });

  function submitted(): UserMessageItem {
    return createUserMessage({
      clientMessageId,
      text: prompt,
      timestamp: new Date("2026-09-01T00:00:00.000Z"),
    });
  }

  function liveUserMessage(): AgentStreamEventPayload {
    return {
      type: "timeline",
      provider: "mock",
      item: {
        type: "user_message",
        text: prompt,
        clientMessageId,
        messageId: clientMessageId,
      },
    };
  }

  it("acknowledges a pending row on a synced tail", () => {
    const result = processAgentStreamEvent({
      event: liveUserMessage(),
      seq: 1,
      epoch: "epoch-1",
      currentTail: [submitted()],
      currentHead: [],
      currentCursor: undefined,
      hasAuthoritativeBaseline: true,
      timestamp: new Date("2026-09-01T00:00:01.000Z"),
    });
    expect(result.acknowledgedClientMessageIds).toEqual([clientMessageId]);
  });

  it("acknowledges a pending row even when the viewed timeline is detached", () => {
    const result = processAgentStreamEvents({
      events: [
        {
          event: liveUserMessage(),
          seq: 1,
          epoch: "epoch-1",
          timestamp: new Date("2026-09-01T00:00:01.000Z"),
        },
      ],
      currentTail: [submitted()],
      currentHead: [],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 4 },
      isDetached: true,
    });
    expect(result.acknowledgedClientMessageIds).toEqual([clientMessageId]);
    expect(result.changedTail).toBe(false);
  });

  it("acknowledges a pending row even when the live event is sequenced as a gap", () => {
    const result = processAgentStreamEvent({
      event: liveUserMessage(),
      seq: 10,
      epoch: "epoch-1",
      currentTail: [submitted()],
      currentHead: [],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 4 },
      hasAuthoritativeBaseline: true,
      timestamp: new Date("2026-09-01T00:00:01.000Z"),
    });
    expect(result.acknowledgedClientMessageIds).toEqual([clientMessageId]);
    expect(result.changedTail).toBe(false);
  });

  it("acknowledges the live clientMessageId even when the snapshot has no pending row", () => {
    const result = processAgentStreamEvent({
      event: liveUserMessage(),
      seq: 1,
      epoch: "epoch-1",
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      hasAuthoritativeBaseline: true,
      timestamp: new Date("2026-09-01T00:00:01.000Z"),
    });
    expect(result.acknowledgedClientMessageIds).toEqual([clientMessageId]);
  });

  it("acknowledges an unreconciled local row by text when the live event omits clientMessageId", () => {
    const result = processAgentStreamEvent({
      event: {
        type: "timeline",
        provider: "mock",
        item: { type: "user_message", text: prompt, messageId: "provider-1" },
      },
      seq: 1,
      epoch: "epoch-1",
      currentTail: [submitted()],
      currentHead: [],
      currentCursor: undefined,
      hasAuthoritativeBaseline: true,
      timestamp: new Date("2026-09-01T00:00:01.000Z"),
    });
    expect(result.acknowledgedClientMessageIds).toEqual([clientMessageId]);
  });

  it("acknowledges a pending head row when the live event omits clientMessageId", () => {
    const result = processAgentStreamEvent({
      event: {
        type: "timeline",
        provider: "mock",
        item: { type: "user_message", text: prompt, messageId: "provider-1" },
      },
      seq: 1,
      epoch: "epoch-1",
      currentTail: [],
      currentHead: [submitted()],
      currentCursor: undefined,
      hasAuthoritativeBaseline: false,
      timestamp: new Date("2026-09-01T00:00:01.000Z"),
    });
    expect(result.acknowledgedClientMessageIds).toEqual([clientMessageId]);
  });

  it("settles a store submission when a live user_message is flushed immediately", () => {
    const store = useSessionStore.getState();
    store.initializeSession("test-server", null as unknown as DaemonClient);
    store.setAgentAuthoritativeHistoryApplied("test-server", agentId, true);
    store.beginAgentMessageSubmission("test-server", agentId, submitted());

    const queue = createAgentStreamReducerQueue({
      getSnapshot: () => {
        const session = useSessionStore.getState().sessions["test-server"];
        const timeline = selectAgentTimelineState(session, agentId);
        return {
          currentTail: timeline.status === "cold" ? [] : timeline.items,
          currentHead: session?.agentStreamHead.get(agentId) ?? [],
          currentCursor: timeline.status === "synced" ? (timeline.range ?? undefined) : undefined,
          hasAuthoritativeBaseline: timeline.status === "synced",
          isDetached: timeline.status === "synced" && timeline.newer === "available",
        };
      },
      commit: (id, result) => {
        useSessionStore.getState().setAgentStreamState("test-server", id, {
          ...(result.changedTail ? { tail: result.tail } : {}),
          ...(result.changedHead ? { head: result.head } : {}),
          ...(result.acknowledgedClientMessageIds.length > 0
            ? { acknowledgedClientMessageIds: result.acknowledgedClientMessageIds }
            : {}),
        });
      },
      handleSideEffects: () => undefined,
      scheduleFlush: () => 1,
      cancelFlush: () => undefined,
    });

    ingestAgentStreamEvent({
      enqueue: (id, event) => queue.enqueue(id, event),
      flushAgent: (id) => queue.flushAgent(id),
      agentId,
      event: {
        event: liveUserMessage(),
        seq: 1,
        epoch: "epoch-1",
        timestamp: new Date("2026-09-01T00:00:01.000Z"),
      },
    });

    expect(
      getActiveMessageSubmissions(
        useSessionStore.getState().sessions["test-server"]?.messageSubmissions.get(agentId),
      ),
    ).toEqual([]);
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
