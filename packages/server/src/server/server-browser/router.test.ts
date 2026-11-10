import { describe, expect, it } from "vitest";
import type { BrowserAutomationExecuteRequest } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { BrowserToolsBroker, type BrowserToolsExecuteInput } from "../browser-tools/broker.js";
import { browserToolsFailure, type BrowserToolsResponsePayload } from "../browser-tools/errors.js";
import { ServerBrowserRouter, type NewTabTargetSetting } from "./router.js";

const SERVER_TAB = "11111111-1111-4111-8111-111111111111";
const APP_TAB = "22222222-2222-4222-8222-222222222222";

function tabInfo(browserId: string) {
  return { browserId, url: "http://localhost:3000/", title: "", isActive: false, isLoading: false };
}

function createAppBroker(options: { connected: boolean }) {
  const received: string[] = [];
  return {
    received,
    getRegisteredClientCount: () => (options.connected ? 1 : 0),
    execute: async (input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> => {
      received.push(input.command.command);
      const requestId = input.requestId ?? "app";
      if (!options.connected) {
        return browserToolsFailure({ requestId, code: "browser_no_host", message: "none" });
      }
      if (input.command.command === "list_tabs") {
        return { requestId, ok: true, result: { command: "list_tabs", tabs: [tabInfo(APP_TAB)] } };
      }
      if (input.command.command === "new_tab") {
        return {
          requestId,
          ok: true,
          result: { command: "new_tab", browserId: APP_TAB, workspaceId: "ws", url: "about:blank" },
        };
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

function newTabOf(result: BrowserToolsResponsePayload) {
  if (!result.ok || result.result.command !== "new_tab") return null;
  return { browserId: result.result.browserId, location: result.result.location };
}

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

  it("opens a new tab in the connected desktop app by default (Automatic)", async () => {
    const app = createAppBroker({ connected: true });
    const server = createServerBrowser({ enabled: true });
    const result = await new ServerBrowserRouter(app, server).execute(newTab);

    expect(newTabOf(result)).toEqual({ browserId: APP_TAB, location: "desktop" });
    expect(server.received).toEqual([]);
  });

  it("opens a new tab in the server browser by default when no desktop app is connected", async () => {
    const app = createAppBroker({ connected: false });
    const server = createServerBrowser({ enabled: true });
    const result = await new ServerBrowserRouter(app, server).execute(newTab);

    expect(newTabOf(result)).toEqual({ browserId: SERVER_TAB, location: "server" });
    expect(app.received).toEqual([]);
  });

  it("opens the tab where the agent asks, whatever the default", async () => {
    const app = createAppBroker({ connected: true });
    const server = createServerBrowser({ enabled: true });
    const router = new ServerBrowserRouter(app, server, () => "desktop");

    const onServer = await router.execute({ ...newTab, target: "server" });
    expect(newTabOf(onServer)).toEqual({ browserId: SERVER_TAB, location: "server" });

    const onDesktop = await new ServerBrowserRouter(app, server, () => "server").execute({
      ...newTab,
      target: "desktop",
    });
    expect(newTabOf(onDesktop)).toEqual({ browserId: APP_TAB, location: "desktop" });
  });

  it.each<[NewTabTargetSetting, string]>([
    ["server", SERVER_TAB],
    ["desktop", APP_TAB],
  ])("follows the host default %s when the agent does not choose", async (setting, expected) => {
    const router = new ServerBrowserRouter(
      createAppBroker({ connected: true }),
      createServerBrowser({ enabled: true }),
      () => setting,
    );
    expect(newTabOf(await router.execute(newTab))?.browserId).toBe(expected);
  });

  it("fails and names the server browser when the agent asks for a desktop that is not connected", async () => {
    const app = createAppBroker({ connected: false });
    const server = createServerBrowser({ enabled: true });
    const result = await new ServerBrowserRouter(app, server).execute({
      ...newTab,
      target: "desktop",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toBe(
      'You asked for target "desktop", but no desktop app with a Browser is connected to this host. Available: target "server" (the server browser), or omit target.',
    );
    expect(app.received).toEqual([]);
    expect(server.received).toEqual([]);
  });

  it("fails and names the desktop app when the agent asks for the server browser while it is off", async () => {
    const app = createAppBroker({ connected: true });
    const server = createServerBrowser({ enabled: false });
    const result = await new ServerBrowserRouter(app, server).execute({
      ...newTab,
      target: "server",
    });

    expect(!result.ok && result.error.message).toBe(
      'You asked for target "server", but the server browser is off on this host (Settings → the host → Browser tools). Available: target "desktop" (the desktop app\'s Browser), or omit target.',
    );
    expect(app.received).toEqual([]);
  });

  it("keeps the host default while the server browser is off: Server fails, Automatic is desktop", async () => {
    const app = createAppBroker({ connected: true });
    const off = createServerBrowser({ enabled: false });

    const serverDefault = await new ServerBrowserRouter(app, off, () => "server").execute(newTab);
    expect(!serverDefault.ok && serverDefault.error.message).toBe(
      'This host\'s default for new tabs is "server", but the server browser is off on this host (Settings → the host → Browser tools). Available: target "desktop" (the desktop app\'s Browser), or omit target.',
    );

    const automatic = await new ServerBrowserRouter(app, off).execute(newTab);
    expect(newTabOf(automatic)).toEqual({ browserId: APP_TAB, location: "desktop" });
    expect(off.received).toEqual([]);
  });

  it("does not fall back when the host default is desktop and none is connected", async () => {
    const router = new ServerBrowserRouter(
      createAppBroker({ connected: false }),
      createServerBrowser({ enabled: true }),
      () => "desktop",
    );
    const result = await router.execute(newTab);
    expect(!result.ok && result.error.message).toContain(
      'This host\'s default for new tabs is "desktop"',
    );
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
    expect(ids.map((tab) => [tab.browserId, tab.location])).toEqual([
      [SERVER_TAB, "server"],
      [APP_TAB, "desktop"],
    ]);
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

  it("says the desktop tabs could not be listed instead of leaving them out", async () => {
    // A desktop app that reconnected leaves its old connection registered, silent, for the
    // reconnect grace: a new tab goes to the newest host, a list waits on every host.
    const broker = new BrowserToolsBroker({ defaultTimeoutMs: 50 });
    const answer = (request: BrowserAutomationExecuteRequest) => {
      const payload: BrowserToolsResponsePayload =
        request.command.command === "new_tab"
          ? {
              requestId: request.requestId,
              ok: true,
              result: {
                command: "new_tab",
                browserId: APP_TAB,
                workspaceId: "ws",
                url: "about:blank",
              },
            }
          : {
              requestId: request.requestId,
              ok: true,
              result: { command: "list_tabs", tabs: [tabInfo(APP_TAB)] },
            };
      setImmediate(() =>
        broker.receiveResponse({ type: "browser.automation.execute.response", payload }),
      );
    };
    broker.registerClient({
      id: "desktop-before-reconnect",
      hostKind: "desktop app",
      supportedCommands: ["list_tabs", "new_tab"],
      sendBrowserAutomationRequest: () => {},
    });
    broker.registerClient({
      id: "desktop",
      hostKind: "desktop app",
      supportedCommands: ["list_tabs", "new_tab"],
      sendBrowserAutomationRequest: answer,
    });
    const router = new ServerBrowserRouter(broker, createServerBrowser({ enabled: true }));

    const opened = await router.execute({ ...newTab, target: "desktop" });
    expect(opened).toMatchObject({ ok: true, result: { browserId: APP_TAB, location: "desktop" } });
    const listed = await router.execute(listTabs);
    expect(listed).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/desktop app's tabs could not be listed/) },
    });
  });
});
