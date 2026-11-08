import { describe, expect, it } from "vitest";
import {
  readAgentMessageFoldState,
  resetAgentMessageFold,
  toggleAgentMessage,
  toggleAgentMessageGroup,
} from "./store";

describe("agent message fold store", () => {
  it("flips one message and one group per agent, and reset clears both", () => {
    const agent = { serverId: "host", agentId: "orchestrator" };
    toggleAgentMessage({ ...agent, id: "a1" });
    toggleAgentMessageGroup({ ...agent, hostId: "b1" });
    const state = readAgentMessageFoldState("host", "orchestrator");
    expect([...state.toggledIds]).toEqual(["a1"]);
    expect([...state.openGroupIds]).toEqual(["b1"]);
    expect(readAgentMessageFoldState("host", "other").toggledIds.size).toBe(0);

    toggleAgentMessage({ ...agent, id: "a1" });
    expect(readAgentMessageFoldState("host", "orchestrator").toggledIds.size).toBe(0);

    resetAgentMessageFold("host", "orchestrator");
    expect(readAgentMessageFoldState("host", "orchestrator").openGroupIds.size).toBe(0);
  });
});
