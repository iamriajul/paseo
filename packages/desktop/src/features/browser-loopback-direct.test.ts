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
      serverId: "server-1",
      workspaceId: "ws-beta",
      rendererWebContentsId: 999,
      directLoopback: false,
    });
    const afterTunnel = setProxy.mock.calls.length;

    await registerBrowserLoopbackProxy({
      browserId: "tab-1",
      serverId: "server-1",
      workspaceId: "ws-beta",
      rendererWebContentsId: 999,
      directLoopback: true,
    });
    expect(setProxy.mock.calls.length).toBeGreaterThan(afterTunnel);

    await unregisterBrowserLoopbackProxy("tab-1");
  });
});
