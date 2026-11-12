import { describe, expect, it } from "vitest";
import { rememberServerTabForward, stopForwardsOfEndedServerTabs } from "./server-tab-forwards";
import type { PortForwardController } from "./types";

function fakeController(): PortForwardController & { stopped: string[] } {
  const stopped: string[] = [];
  return {
    device: "computer",
    stopped,
    start: async () => ({ kind: "started", forwards: [] }),
    stop: async () => {},
    stopAll: async (browserId) => {
      stopped.push(browserId);
    },
    list: async () => ({ forwards: [], observedPorts: [] }),
  };
}

describe("server tab forwards", () => {
  it("stops a tab's forwards when the host stops listing it or suspends it, once", () => {
    const controller = fakeController();
    rememberServerTabForward("host-a", "tab-1");
    rememberServerTabForward("host-a", "tab-2");
    rememberServerTabForward("host-a", "tab-3");
    rememberServerTabForward("host-b", "tab-9");

    stopForwardsOfEndedServerTabs(
      "host-a",
      [{ browserId: "tab-1" }, { browserId: "tab-3", suspended: true }],
      controller,
    );
    expect(controller.stopped.sort()).toEqual(["tab-2", "tab-3"]);

    stopForwardsOfEndedServerTabs("host-a", [{ browserId: "tab-1" }], controller);
    expect(controller.stopped.sort()).toEqual(["tab-2", "tab-3"]);

    stopForwardsOfEndedServerTabs("host-a", [], controller);
    expect(controller.stopped.sort()).toEqual(["tab-1", "tab-2", "tab-3"]);
  });

  it("leaves other hosts' tabs alone", () => {
    const controller = fakeController();
    rememberServerTabForward("host-c", "tab-x");
    stopForwardsOfEndedServerTabs("host-d", [], controller);
    expect(controller.stopped).toEqual([]);
    stopForwardsOfEndedServerTabs("host-c", [], controller);
    expect(controller.stopped).toEqual(["tab-x"]);
  });
});
