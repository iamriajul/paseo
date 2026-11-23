import { describe, expect, it } from "vitest";
import { isWorkspaceRootAgent } from "./workspace-root-policy";

describe("isWorkspaceRootAgent", () => {
  it("treats an agent with no parent as a root", () => {
    expect(
      isWorkspaceRootAgent({ parentAgentId: null, workspaceId: "w1", labels: {} }, undefined),
    ).toBe(true);
  });

  it("keeps a subagent out of the workspace's roots", () => {
    expect(
      isWorkspaceRootAgent(
        { parentAgentId: "p", workspaceId: "w1", labels: {} },
        { workspaceId: "w1" },
      ),
    ).toBe(false);
  });

  it("keeps a side question out of the roots, though it has no parent label", () => {
    expect(
      isWorkspaceRootAgent(
        { parentAgentId: null, workspaceId: "w1", labels: { "paseo.side-question-of": "main" } },
        undefined,
      ),
    ).toBe(false);
  });
});
