import { describe, expect, it } from "vitest";
import {
  AGENT_CHAT_DISPLAY_LABEL,
  agentChatDisplayLabelPatch,
  resolveAgentChatDisplay,
} from "./agent-override";

describe("agent chat display override", () => {
  it("follows Settings when the agent has no label", () => {
    expect(resolveAgentChatDisplay({ global: "collapseTurns", labels: {} })).toEqual({
      effective: "collapseTurns",
      override: null,
      global: "collapseTurns",
    });
  });

  it("uses the agent's own choice over Settings", () => {
    const display = resolveAgentChatDisplay({
      global: "collapseTurns",
      labels: { [AGENT_CHAT_DISPLAY_LABEL]: "full" },
    });
    expect(display.effective).toBe("full");
    expect(display.override).toBe("full");
  });

  it("reads the follow-Settings write, and any unknown value, as no override", () => {
    const followed = agentChatDisplayLabelPatch(null);
    expect(resolveAgentChatDisplay({ global: "full", labels: followed }).override).toBeNull();
    expect(
      resolveAgentChatDisplay({
        global: "full",
        labels: { [AGENT_CHAT_DISPLAY_LABEL]: "somethingNewer" },
      }).effective,
    ).toBe("full");
  });

  it("round-trips every mode through the label", () => {
    for (const mode of ["full", "collapseToolCalls", "collapseTurns"] as const) {
      const labels = agentChatDisplayLabelPatch(mode);
      expect(resolveAgentChatDisplay({ global: "full", labels }).override).toBe(mode);
    }
  });
});
