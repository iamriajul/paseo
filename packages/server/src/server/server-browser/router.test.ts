import { describe, expect, it } from "vitest";
import type { BrowserAutomationExecuteRequest } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { BrowserToolsExecuteInput } from "../browser-tools/broker.js";
import { browserToolsFailure, type BrowserToolsResponsePayload } from "../browser-tools/errors.js";
import { ServerBrowserRouter } from "./router.js";

const SERVER_TAB = "11111111-1111-4111-8111-111111111111";
const APP_TAB = "22222222-2222-4222-8222-222222222222";

function tabInfo(browserId: string) {
  return { browserId, url: "http://localhost:3000/", title: "", isActive: false, isLoading: false };
}

function createAppBroker(options: { connected: boolean }) {
  const received: string[] = [];
  return {
    received,
    execute: async (input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> => {
      received.push(input.command.command);
      const requestId = input.requestId ?? "app";
      if (!options.connected) {
        return browserToolsFailure({ requestId, code: "browser_no_host", message: "none" });
      }
      if (input.command.command === "list_tabs") {
        return { requestId, ok: true, result: { command: "list_tabs", tabs: [tabInfo(APP_TAB)] } };
      }
      return { requestId, ok: true, result: { command: "reload", browserId: APP_TAB } };
    },
  };
}

function createServerBrowser(options: { enabled: boolean }) {
  const received: string[] = [];
  return {
    received,
    isEnabled: () => options.enabled,
    ownsTab: (browserId: string) => browserId === SERVER_TAB,
    execute: async (
      request: BrowserAutomationExecuteRequest,
    ): Promise<BrowserToolsResponsePayload> => {
      received.push(request.command.command);
      if (request.command.command === "list_tabs") {
        return {
          requestId: request.requestId,
          ok: true,
          result: { command: "list_tabs", tabs: [tabInfo(SERVER_TAB)] },
        };
      }
      return {
        requestId: request.requestId,
        ok: true,
        result: {
          command: "new_tab",
          browserId: SERVER_TAB,
          workspaceId: "ws",
          url: "about:blank",
        },
      };
    },
  };
}

const newTab: BrowserToolsExecuteInput = {
  workspaceId: "ws",
  command: { command: "new_tab", args: { url: "http://localhost:3000/" } },
};
const reload = (browserId: string): BrowserToolsExecuteInput => ({
  workspaceId: "ws",
  command: { command: "reload", args: { browserId } },
});
const listTabs: BrowserToolsExecuteInput = { command: { command: "list_tabs", args: {} } };

describe("ServerBrowserRouter", () => {
  it("leaves every command with the app browser while the switch is off", async () => {
    const app = createAppBroker({ connected: true });
    const server = createServerBrowser({ enabled: false });
    const router = new ServerBrowserRouter(app, server);

    await router.execute(newTab);
    await router.execute(reload(SERVER_TAB));
    await router.execute(listTabs);

    expect(app.received).toEqual(["new_tab", "reload", "list_tabs"]);
    expect(server.received).toEqual([]);
  });

  it("opens every new tab in the server browser while the switch is on, even with an app connected", async () => {
    const app = createAppBroker({ connected: true });
    const server = createServerBrowser({ enabled: true });
    const result = await new ServerBrowserRouter(app, server).execute(newTab);

    expect(result.ok && result.result.command === "new_tab" && result.result.browserId).toBe(
      SERVER_TAB,
    );
    expect(app.received).toEqual([]);
  });

  it("sends a command to whichever browser owns its tab", async () => {
    const app = createAppBroker({ connected: true });
    const server = createServerBrowser({ enabled: true });
    const router = new ServerBrowserRouter(app, server);

    await router.execute(reload(SERVER_TAB));
    await router.execute(reload(APP_TAB));

    expect(server.received).toEqual(["reload"]);
    expect(app.received).toEqual(["reload"]);
  });

  it("lists server and app tabs together", async () => {
    const router = new ServerBrowserRouter(
      createAppBroker({ connected: true }),
      createServerBrowser({ enabled: true }),
    );
    const result = await router.execute(listTabs);
    const ids = result.ok && result.result.command === "list_tabs" ? result.result.tabs : [];
    expect(ids.map((tab) => tab.browserId)).toEqual([SERVER_TAB, APP_TAB]);
  });

  it("lists server tabs when no app is connected, the laptop-closed case", async () => {
    const router = new ServerBrowserRouter(
      createAppBroker({ connected: false }),
      createServerBrowser({ enabled: true }),
    );
    const result = await router.execute(listTabs);
    expect(result.ok).toBe(true);
    const ids = result.ok && result.result.command === "list_tabs" ? result.result.tabs : [];
    expect(ids.map((tab) => tab.browserId)).toEqual([SERVER_TAB]);
  });
});
