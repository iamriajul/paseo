import {
  BrowserAutomationExecuteRequestSchema,
  type BrowserAutomationExecuteRequest,
  type BrowserAutomationTabLocation,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { randomUUID } from "node:crypto";
import type { BrowserToolsBroker, BrowserToolsExecuteInput } from "../browser-tools/broker.js";
import { browserToolsFailure, type BrowserToolsResponsePayload } from "../browser-tools/errors.js";

export interface ServerBrowserCommandTarget {
  isEnabled(): boolean;
  ownsTab(browserId: string): boolean;
  execute(request: BrowserAutomationExecuteRequest): Promise<BrowserToolsResponsePayload>;
}

/** The host setting `serverBrowser.newTabTarget`: where a tab opens when the agent does not say. */
export type NewTabTargetSetting = "auto" | BrowserAutomationTabLocation;

export function resolveNewTabTargetSetting(value: string | undefined): NewTabTargetSetting {
  return value === "server" || value === "desktop" ? value : "auto";
}

type AppBroker = Pick<BrowserToolsBroker, "execute" | "getRegisteredClientCount">;

/**
 * Decides which browser serves an MCP browser command.
 *
 * A new tab opens where the agent asked (`target`), else where the host setting says; Automatic
 * picks a connected desktop app's Browser (the user is at the laptop) and otherwise the server
 * browser (it works with every app closed). An unavailable target fails and names what is
 * available instead of falling back. A tab stays on the browser it opened in: a tab the server
 * browser owns goes there, any other browserId goes to the app broker.
 * The setting is independent of the server browser switch: with the switch off, Automatic means
 * the desktop app and Server fails. Commands on existing tabs go to the app broker, as upstream.
 */
export class ServerBrowserRouter {
  public constructor(
    private readonly broker: AppBroker,
    private readonly server: ServerBrowserCommandTarget,
    private readonly defaultTarget: () => NewTabTargetSetting = () => "auto",
  ) {}

  public async execute(input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> {
    const command = input.command;
    if (command.command === "list_tabs") return this.listTabs(input);
    if (command.command === "new_tab") return this.newTab(input);
    if (this.server.isEnabled() && this.server.ownsTab(command.args.browserId)) {
      return this.executeOnServer(input);
    }
    return this.broker.execute(input);
  }

  private async newTab(input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> {
    const location = this.resolveNewTabLocation(input);
    if (!location.ok) return location.payload;
    const payload =
      location.value === "server"
        ? await this.executeOnServer(input)
        : await this.broker.execute(input);
    if (!payload.ok || payload.result.command !== "new_tab") return payload;
    return { ...payload, result: { ...payload.result, location: location.value } };
  }

  private resolveNewTabLocation(
    input: BrowserToolsExecuteInput,
  ):
    | { ok: true; value: BrowserAutomationTabLocation }
    | { ok: false; payload: BrowserToolsResponsePayload } {
    const serverOn = this.server.isEnabled();
    const desktopConnected = this.broker.getRegisteredClientCount() > 0;
    const wanted = input.target ?? this.defaultTarget();
    if (wanted === "auto") {
      return { ok: true, value: desktopConnected || !serverOn ? "desktop" : "server" };
    }
    if (wanted === "server" && serverOn) return { ok: true, value: "server" };
    if (wanted === "desktop" && desktopConnected) return { ok: true, value: "desktop" };

    const askedBy = input.target
      ? `You asked for target "${wanted}"`
      : `This host's default for new tabs is "${wanted}"`;
    const unavailable =
      wanted === "server"
        ? "the server browser is off on this host (Settings → the host → Browser tools)"
        : "no desktop app with a Browser is connected to this host";
    const available = describeAvailable({ serverOn, desktopConnected });
    return {
      ok: false,
      payload: browserToolsFailure({
        requestId: input.requestId ?? `browser_${randomUUID()}`,
        code: "browser_no_host",
        message: `${askedBy}, but ${unavailable}. ${available}`,
        retryable: true,
      }),
    };
  }

  private async executeOnServer(
    input: BrowserToolsExecuteInput,
  ): Promise<BrowserToolsResponsePayload> {
    const requestId = input.requestId ?? `browser_${randomUUID()}`;
    const parsed = BrowserAutomationExecuteRequestSchema.safeParse({
      type: "browser.automation.execute.request",
      requestId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      command: input.command,
    });
    if (!parsed.success) {
      return browserToolsFailure({
        requestId,
        code: "browser_unknown_error",
        message: `Browser automation request is invalid: ${parsed.error.issues[0]?.message ?? "unknown"}.`,
      });
    }
    return this.server.execute(parsed.data);
  }

  private async listTabs(input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> {
    if (!this.server.isEnabled()) {
      return withTabLocation(await this.broker.execute(input), "desktop");
    }
    const [server, app] = await Promise.all([
      this.executeOnServer(input),
      this.broker.execute(input),
    ]);
    if (!server.ok) return server;
    const serverTabs = tabsOf(withTabLocation(server, "server"));
    // No app connected is normal once the browser lives on the server.
    const appTabs = tabsOf(withTabLocation(app, "desktop"));
    return {
      requestId: server.requestId,
      ok: true,
      result: { command: "list_tabs", tabs: [...serverTabs, ...appTabs] },
    };
  }
}

function describeAvailable(params: { serverOn: boolean; desktopConnected: boolean }): string {
  const { serverOn, desktopConnected } = params;
  if (serverOn && desktopConnected) {
    return 'Available: target "server" (the server browser) and target "desktop" (the desktop app\'s Browser).';
  }
  if (serverOn) return 'Available: target "server" (the server browser), or omit target.';
  if (desktopConnected) {
    return 'Available: target "desktop" (the desktop app\'s Browser), or omit target.';
  }
  return "No browser is available: open the Paseo desktop app or turn on the server browser.";
}

function withTabLocation(
  payload: BrowserToolsResponsePayload,
  location: BrowserAutomationTabLocation,
): BrowserToolsResponsePayload {
  if (!payload.ok || payload.result.command !== "list_tabs") return payload;
  const tabs = payload.result.tabs.map((tab) => ({ ...tab, location }));
  return { ...payload, result: { ...payload.result, tabs } };
}

function tabsOf(payload: BrowserToolsResponsePayload) {
  return payload.ok && payload.result.command === "list_tabs" ? payload.result.tabs : [];
}
