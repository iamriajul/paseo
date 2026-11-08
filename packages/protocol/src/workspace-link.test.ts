import { describe, expect, it } from "vitest";
import {
  buildWorkspaceLinkFields,
  buildWorkspaceLinkUrl,
  buildWorkspaceMarkdownLink,
  parseWorkspaceLink,
} from "./workspace-link.js";

describe("workspace links", () => {
  it("round-trips the workspace and preview forms", () => {
    const workspace = { serverId: "srv/main", workspaceId: "wks 1", view: "workspace" as const };
    const preview = { ...workspace, view: "preview" as const };

    expect(buildWorkspaceLinkUrl(workspace)).toBe("paseo://h/srv%2Fmain/workspace/wks%201");
    expect(buildWorkspaceLinkUrl(preview)).toBe("paseo://h/srv%2Fmain/workspace/wks%201/preview");
    expect(parseWorkspaceLink(buildWorkspaceLinkUrl(workspace))).toEqual(workspace);
    expect(parseWorkspaceLink(buildWorkspaceLinkUrl(preview))).toEqual(preview);
  });

  it("accepts a trailing slash and an upper-case scheme", () => {
    expect(parseWorkspaceLink("PASEO://h/srv/workspace/wks_1/")).toEqual({
      serverId: "srv",
      workspaceId: "wks_1",
      view: "workspace",
    });
  });

  it("rejects anything outside the two exact forms", () => {
    expect(parseWorkspaceLink("https://h/srv/workspace/wks_1")).toBeNull();
    expect(parseWorkspaceLink("paseo://h/srv/agent/agent-1")).toBeNull();
    expect(parseWorkspaceLink("paseo://h/srv/workspace/wks_1/terminal")).toBeNull();
    expect(parseWorkspaceLink("paseo://h/srv/workspace/wks_1?open=x")).toBeNull();
    expect(parseWorkspaceLink("paseo://h/srv/workspace/%E0%A4%A")).toBeNull();
  });

  it("escapes brackets in the Markdown label", () => {
    expect(buildWorkspaceMarkdownLink("fix [beta]\nbuild", "paseo://h/s/workspace/w")).toBe(
      "[fix \\[beta\\] build](paseo://h/s/workspace/w)",
    );
  });

  it("adds preview fields only when the workspace has a main preview", () => {
    const base = { serverId: "srv", workspaceId: "wks_1", label: "Docs" };

    expect(buildWorkspaceLinkFields({ ...base, hasPreview: false })).toEqual({
      link: "[Docs](paseo://h/srv/workspace/wks_1)",
      url: "paseo://h/srv/workspace/wks_1",
    });
    expect(buildWorkspaceLinkFields({ ...base, hasPreview: true })).toEqual({
      link: "[Docs](paseo://h/srv/workspace/wks_1)",
      url: "paseo://h/srv/workspace/wks_1",
      previewLink: "[Docs preview](paseo://h/srv/workspace/wks_1/preview)",
      previewUrl: "paseo://h/srv/workspace/wks_1/preview",
    });
  });
});
