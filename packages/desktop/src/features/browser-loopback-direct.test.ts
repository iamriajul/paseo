import { beforeEach, describe, expect, test, vi } from "vitest";

const setProxy = vi.fn(async () => undefined);
const closeAllConnections = vi.fn(async () => undefined);

vi.mock("electron", () => ({
  session: {
    fromPartition: () => ({ setProxy, closeAllConnections }),
  },
  webContents: {
    fromId: () => null,
  },
}));

import {
  registerBrowserLoopbackProxy,
  unregisterBrowserLoopbackProxy,
} from "./browser-loopback-proxy";

beforeEach(() => {
  setProxy.mockClear();
  closeAllConnections.mockClear();
});

describe("direct loopback re-registration", () => {
  test("does not re-apply setProxy when the workspace is already direct", async () => {
    await registerBrowserLoopbackProxy({
      browserId: "tab-1",
      serverId: "server-1",
      workspaceId: "ws-alpha",
      rendererWebContentsId: 999,
      directLoopback: true,
    });
    expect(setProxy).toHaveBeenCalledTimes(1);

    // A remount (or a second tab in the same workspace) re-registers: the
    // session is already direct, so re-applying setProxy must be skipped or it
    // lands mid-commit and kills the first navigation (blank guest).
    await registerBrowserLoopbackProxy({
      browserId: "tab-2",
      serverId: "server-1",
      workspaceId: "ws-alpha",
      rendererWebContentsId: 999,
      directLoopback: true,
    });
    expect(setProxy).toHaveBeenCalledTimes(1);

    await unregisterBrowserLoopbackProxy("tab-1");
    await unregisterBrowserLoopbackProxy("tab-2");
  });

  test("applies setProxy when switching the workspace to direct", async () => {
    await registerBrowserLoopbackProxy({
      browserId: "tab-1",
      serverId: "server-2",
      workspaceId: "ws-beta",
      rendererWebContentsId: 999,
      directLoopback: false,
    });
    const afterTunnel = setProxy.mock.calls.length;

    await registerBrowserLoopbackProxy({
      browserId: "tab-1",
      serverId: "server-2",
      workspaceId: "ws-beta",
      rendererWebContentsId: 999,
      directLoopback: true,
    });
    expect(setProxy.mock.calls.length).toBeGreaterThan(afterTunnel);

    await unregisterBrowserLoopbackProxy("tab-1");
  });

  test("a pane registering without the flag keeps a declared-local host direct", async () => {
    // browser_new_tab (automation) knows the connection is this machine and
    // registers direct. The pane that mounts for the same tab registers without
    // the flag. Flipping the session to the tunnel proxy there ran
    // closeAllConnections() mid-load and left the tab blank.
    await registerBrowserLoopbackProxy({
      browserId: "agent-tab",
      serverId: "local-daemon",
      workspaceId: "ws-gamma",
      rendererWebContentsId: 999,
      directLoopback: true,
    });
    setProxy.mockClear();
    closeAllConnections.mockClear();

    await registerBrowserLoopbackProxy({
      browserId: "agent-tab",
      serverId: "local-daemon",
      workspaceId: "ws-gamma",
      rendererWebContentsId: 999,
    });
    await registerBrowserLoopbackProxy({
      browserId: "user-tab",
      serverId: "local-daemon",
      workspaceId: "ws-delta",
      rendererWebContentsId: 999,
    });

    expect(setProxy).not.toHaveBeenCalledWith(expect.objectContaining({ mode: "fixed_servers" }));
    expect(closeAllConnections).not.toHaveBeenCalled();

    await unregisterBrowserLoopbackProxy("agent-tab");
    await unregisterBrowserLoopbackProxy("user-tab");
  });
});
