import { describe, expect, it } from "vitest";
import type { WorkspaceLinkTarget } from "@getpaseo/protocol/workspace-link";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { resolveWorkspaceLinkOpen, type WorkspaceLinkHostState } from "./resolve";
import { previewRequestKey, usePreviewRequestStore } from "./preview-requests";

function workspace(id: string, scripts: Array<Partial<WorkspaceDescriptor["scripts"][number]>>) {
  return { id, scripts } as unknown as WorkspaceDescriptor;
}

const docs = workspace("wks_docs", [{ scriptName: "web", type: "service", preview: true }]);
const plain = workspace("wks_plain", [{ scriptName: "api", type: "service" }]);

function host(overrides: Partial<WorkspaceLinkHostState> = {}): WorkspaceLinkHostState {
  return {
    connected: true,
    workspacesHydrated: true,
    workspaces: new Map([
      ["wks_docs", docs],
      ["wks_plain", plain],
    ]),
    ...overrides,
  };
}

function link(workspaceId: string, view: WorkspaceLinkTarget["view"] = "workspace") {
  return { serverId: "srv-1", workspaceId, view };
}

describe("resolveWorkspaceLinkOpen", () => {
  it("navigates to a known workspace", () => {
    expect(resolveWorkspaceLinkOpen(link("wks_plain"), host())).toEqual({
      kind: "navigate",
      serverId: "srv-1",
      workspaceId: "wks_plain",
      preview: "none",
    });
  });

  it("asks the workspace to open its main preview", () => {
    expect(resolveWorkspaceLinkOpen(link("wks_docs", "preview"), host())).toEqual({
      kind: "navigate",
      serverId: "srv-1",
      workspaceId: "wks_docs",
      preview: "open",
    });
  });

  it("opens the workspace but reports a preview link to a workspace without one", () => {
    expect(resolveWorkspaceLinkOpen(link("wks_plain", "preview"), host())).toEqual({
      kind: "preview-missing",
      serverId: "srv-1",
      workspaceId: "wks_plain",
    });
  });

  it("reports an unknown or archived workspace once the host's list has loaded", () => {
    expect(resolveWorkspaceLinkOpen(link("wks_gone"), host())).toEqual({
      kind: "workspace-missing",
    });
  });

  it("navigates before the list loads and leaves the missing state to the workspace screen", () => {
    expect(
      resolveWorkspaceLinkOpen(
        link("wks_later", "preview"),
        host({ workspacesHydrated: false, workspaces: new Map() }),
      ),
    ).toEqual({ kind: "navigate", serverId: "srv-1", workspaceId: "wks_later", preview: "open" });
  });

  it("reports a host that is unknown or not connected", () => {
    expect(resolveWorkspaceLinkOpen(link("wks_docs"), null)).toEqual({
      kind: "host-unavailable",
    });
    expect(resolveWorkspaceLinkOpen(link("wks_docs"), host({ connected: false }))).toEqual({
      kind: "host-unavailable",
    });
  });
});

describe("preview requests", () => {
  it("hands a request to the named workspace exactly once", () => {
    const store = usePreviewRequestStore.getState();
    store.request(previewRequestKey("srv-1", "wks_docs"));

    expect(store.take(previewRequestKey("srv-1", "wks_plain"))).toBe(false);
    expect(store.take(previewRequestKey("srv-1", "wks_docs"))).toBe(true);
    expect(store.take(previewRequestKey("srv-1", "wks_docs"))).toBe(false);
  });
});
