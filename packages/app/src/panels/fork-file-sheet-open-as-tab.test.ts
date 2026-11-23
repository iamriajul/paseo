import { describe, expect, it } from "vitest";
import { panelCompactSheetPolicy, type PanelTargetFacts } from "@/panels/panel-manifest";

const facts: PanelTargetFacts = {
  isWorkspaceRootAgent: () => false,
  isSideQuestionAgent: (agentId) => agentId === "side",
};

describe("fork compact file sheet", () => {
  it("offers Open as tab for a file, as for a Paseo subagent", () => {
    expect(panelCompactSheetPolicy({ kind: "file", path: "notes.md" }, facts)).toEqual({
      openAsTab: true,
    });
    expect(panelCompactSheetPolicy({ kind: "agent", agentId: "child" }, facts)).toEqual({
      openAsTab: true,
    });
  });

  it("keeps a side question in its sheet with no Open as tab, and never in the tab strip", () => {
    expect(panelCompactSheetPolicy({ kind: "agent", agentId: "side" }, facts)).toEqual({
      openAsTab: false,
    });
    expect(
      panelCompactSheetPolicy(
        { kind: "agent", agentId: "side" },
        { isWorkspaceRootAgent: () => true, isSideQuestionAgent: () => true },
      ),
    ).toEqual({ openAsTab: false });
  });

  it("keeps a provider subagent in its read-only sheet", () => {
    expect(
      panelCompactSheetPolicy(
        { kind: "provider_subagent", parentAgentId: "parent", subagentId: "sub" },
        facts,
      ),
    ).toEqual({ openAsTab: false });
  });
});
