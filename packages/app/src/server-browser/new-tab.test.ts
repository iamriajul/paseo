import { describe, expect, it, vi } from "vitest";
import { openNewServerBrowserTab } from "./new-tab";

describe("openNewServerBrowserTab", () => {
  it("opens a blank server tab in the workspace and shows it", async () => {
    const serverBrowserOpenTab = vi.fn(async () => "tab-1");
    const open = vi.fn();
    await openNewServerBrowserTab({ client: { serverBrowserOpenTab }, workspaceId: "ws-1", open });
    expect(serverBrowserOpenTab).toHaveBeenCalledWith("ws-1", "about:blank");
    expect(open).toHaveBeenCalledWith({ kind: "server_browser", browserId: "tab-1" });
  });

  it("shows nothing when the host refuses the tab", async () => {
    const open = vi.fn();
    await expect(
      openNewServerBrowserTab({
        client: {
          serverBrowserOpenTab: async () => {
            throw new Error("Close a tab first");
          },
        },
        workspaceId: "ws-1",
        open,
      }),
    ).rejects.toThrow("Close a tab first");
    expect(open).not.toHaveBeenCalled();
  });
});
