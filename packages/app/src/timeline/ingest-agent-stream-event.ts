import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { AgentStreamReducerEvent } from "./session-stream-reducers";

export function isUserMessageStreamEvent(event: AgentStreamEventPayload): boolean {
  return event.type === "timeline" && event.item.type === "user_message";
}

export function ingestAgentStreamEvent(input: {
  enqueue: (agentId: string, event: AgentStreamReducerEvent) => void;
  flushAgent: (agentId: string) => void;
  agentId: string;
  event: AgentStreamReducerEvent;
}): void {
  input.enqueue(input.agentId, input.event);
  if (isUserMessageStreamEvent(input.event.event)) {
    input.flushAgent(input.agentId);
  }
}

export function flushPendingSubmissionsBeforeClearingLiveness(input: {
  flushAgent: (agentId: string) => void;
  pendingAgentIds: Iterable<string>;
  clearTurnLiveness: () => void;
}): void {
  for (const agentId of input.pendingAgentIds) {
    input.flushAgent(agentId);
  }
  input.clearTurnLiveness();
}
