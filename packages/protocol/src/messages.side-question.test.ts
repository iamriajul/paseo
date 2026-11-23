import { describe, expect, it } from "vitest";
import {
  AgentSideQuestionEstimateResponseMessageSchema,
  AgentSideQuestionOpenRequestMessageSchema,
  AgentSideQuestionOpenResponseMessageSchema,
  ServerInfoStatusPayloadSchema,
} from "./messages.js";
import {
  getSideQuestionSourceId,
  isSideQuestionAgent,
  SIDE_QUESTION_OF_LABEL,
} from "./agent-labels.js";

describe("agent.side_question wire", () => {
  it("opens at the latest point with no boundary", () => {
    const parsed = AgentSideQuestionOpenRequestMessageSchema.parse({
      type: "agent.side_question.open.request",
      requestId: "r1",
      agentId: "agt_1",
    });
    expect(parsed.boundaryMessageId).toBeUndefined();
    expect(parsed.boundaryCursor).toBeUndefined();
  });

  it("opens at an earlier reply when given a boundary", () => {
    const parsed = AgentSideQuestionOpenRequestMessageSchema.parse({
      type: "agent.side_question.open.request",
      requestId: "r1",
      agentId: "agt_1",
      boundaryCursor: { epoch: "e", seq: 4 },
      boundaryMessageId: "msg_1",
    });
    expect(parsed.boundaryCursor).toEqual({ epoch: "e", seq: 4 });
  });

  it("parses an accepted and a rejected open response", () => {
    expect(
      AgentSideQuestionOpenResponseMessageSchema.parse({
        type: "agent.side_question.open.response",
        payload: {
          requestId: "r1",
          sourceAgentId: "agt_1",
          accepted: true,
          error: null,
          agentId: "agt_side",
          workspaceId: "ws_1",
        },
      }).payload.agentId,
    ).toBe("agt_side");
    expect(
      AgentSideQuestionOpenResponseMessageSchema.parse({
        type: "agent.side_question.open.response",
        payload: { requestId: "r1", sourceAgentId: "agt_1", accepted: false, error: "no" },
      }).payload.accepted,
    ).toBe(false);
  });

  it("parses each cache estimate state", () => {
    for (const estimate of [
      { point: "latest", state: "warm", tokens: 412_000, expiredAgoMs: null },
      { point: "latest", state: "expired", tokens: 412_000, expiredAgoMs: 720_000 },
      { point: "earlier", state: "unknown", tokens: null, expiredAgoMs: null },
    ]) {
      expect(
        AgentSideQuestionEstimateResponseMessageSchema.parse({
          type: "agent.side_question.estimate.response",
          payload: { requestId: "r1", agentId: "agt_side", estimate, error: null },
        }).payload.estimate,
      ).toEqual(estimate);
    }
  });

  it("advertises the feature as optional, so an older daemon still parses", () => {
    const base = { status: "server_info" as const, serverId: "srv_1" };
    expect(
      ServerInfoStatusPayloadSchema.parse({ ...base, features: {} }).features?.sideQuestions,
    ).toBeUndefined();
    expect(
      ServerInfoStatusPayloadSchema.parse({ ...base, features: { sideQuestions: true } }).features
        ?.sideQuestions,
    ).toBe(true);
  });
});

describe("side question label", () => {
  it("names the chat the question was asked in", () => {
    const labels = { [SIDE_QUESTION_OF_LABEL]: " agt_main " };
    expect(getSideQuestionSourceId(labels)).toBe("agt_main");
    expect(isSideQuestionAgent({ labels })).toBe(true);
  });

  it("is absent on an ordinary agent", () => {
    expect(getSideQuestionSourceId({})).toBeNull();
    expect(getSideQuestionSourceId({ [SIDE_QUESTION_OF_LABEL]: "  " })).toBeNull();
    expect(isSideQuestionAgent({ labels: null })).toBe(false);
  });
});
