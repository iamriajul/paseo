import { describe, expect, it } from "vitest";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";

describe("Workspaces group mode", () => {
  it("defaults to Project grouping so the header control has a selected segment", () => {
    expect(useSidebarViewStore.getInitialState().groupMode).toBe("project");
  });
});
