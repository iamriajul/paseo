import { describe, expect, it } from "vitest";
import { useBrowserStore } from "@/desktop/browser/store";
import { rememberBrowserTabForward, stopForwardsOfEndedBrowserTabs } from "./browser-tab-forwards";
import type { PortForwardController } from "./types";

function fakeController(): PortForwardController & { stopped: string[] } {
  const stopped: string[] = [];
  return {
    device: "phone",
    stopped,
    start: async () => ({ kind: "started", forwards: [] }),
    stop: async () => {},
    stopAll: async (browserId) => {
      stopped.push(browserId);
    },
    list: async () => ({ forwards: [], observedPorts: [] }),
  };
}

describe("Android Browser tab forwards", () => {
  it("stop when the tab closes or leaves localhost, and only then", () => {
    const controller = fakeController();
    rememberBrowserTabForward("tab-closed", controller);
    rememberBrowserTabForward("tab-away", controller);
    rememberBrowserTabForward("tab-other-port", controller);

    const ended = stopForwardsOfEndedBrowserTabs(
      {
        "tab-away": { url: "https://example.com/" },
        "tab-other-port": { url: "http://127.0.0.1:3000/next" },
      },
      controller,
    );

    expect(ended.sort()).toEqual(["tab-away", "tab-closed"]);
    expect(controller.stopped.sort()).toEqual(["tab-away", "tab-closed"]);

    stopForwardsOfEndedBrowserTabs({}, controller);
    expect(controller.stopped.sort()).toEqual(["tab-away", "tab-closed", "tab-other-port"]);
    stopForwardsOfEndedBrowserTabs({}, controller);
    expect(controller.stopped).toHaveLength(3);
  });

  it("follows the browser store: closing the tab stops its forwards", () => {
    const controller = fakeController();
    const store = useBrowserStore.getState();
    const browserId = store.createBrowser({ initialUrl: "http://localhost:5173/" });
    rememberBrowserTabForward(browserId, controller);

    useBrowserStore.getState().updateBrowser(browserId, { url: "http://localhost:5173/about" });
    expect(controller.stopped).toEqual([]);

    useBrowserStore.getState().removeBrowser(browserId);
    expect(controller.stopped).toEqual([browserId]);
  });
});
