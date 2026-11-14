import { describe, expect, it } from "vitest";
import { panelCompactSheetPolicy, type PanelTargetFacts } from "@/panels/panel-manifest";

const facts: PanelTargetFacts = { isWorkspaceRootAgent: () => false };

describe("fork compact file sheet", () => {
  it("offers Open as tab for a file, as for a Paseo subagent", () => {
    expect(panelCompactSheetPolicy({ kind: "file", path: "notes.md" }, facts)).toEqual({
      openAsTab: true,
    });
    expect(panelCompactSheetPolicy({ kind: "agent", agentId: "child" }, facts)).toEqual({
      openAsTab: true,
    });
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
