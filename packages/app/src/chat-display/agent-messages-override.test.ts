import { describe, expect, it } from "vitest";
import {
  AGENT_MESSAGES_DISPLAY_LABEL,
  agentMessagesDisplayLabelPatch,
  resolveAgentMessagesDisplay,
} from "./agent-messages-override";

describe("agent messages display override", () => {
  it("follows Settings without a label, and for an unknown value", () => {
    expect(resolveAgentMessagesDisplay({ global: "collapsed", labelValue: undefined })).toEqual({
      effective: "collapsed",
      override: null,
      global: "collapsed",
    });
    expect(
      resolveAgentMessagesDisplay({ global: "expanded", labelValue: "somethingNewer" }).effective,
    ).toBe("expanded");
  });

  it("saves a choice that differs from Settings and reads it back", () => {
    const patch = agentMessagesDisplayLabelPatch({ choice: "expanded", global: "collapsed" });
    const labelValue = patch[AGENT_MESSAGES_DISPLAY_LABEL];
    expect(resolveAgentMessagesDisplay({ global: "collapsed", labelValue })).toMatchObject({
      effective: "expanded",
      override: "expanded",
    });
  });

  it("follows Settings again when the choice matches it", () => {
    const patch = agentMessagesDisplayLabelPatch({ choice: "collapsed", global: "collapsed" });
    const labelValue = patch[AGENT_MESSAGES_DISPLAY_LABEL];
    expect(resolveAgentMessagesDisplay({ global: "expanded", labelValue }).effective).toBe(
      "expanded",
    );
  });
});
