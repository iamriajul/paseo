import {
  BrowserAutomationExecuteRequestSchema,
  type BrowserAutomationExecuteRequest,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { randomUUID } from "node:crypto";
import type { BrowserToolsBroker, BrowserToolsExecuteInput } from "../browser-tools/broker.js";
import { browserToolsFailure, type BrowserToolsResponsePayload } from "../browser-tools/errors.js";

export interface ServerBrowserCommandTarget {
  isEnabled(): boolean;
  ownsTab(browserId: string): boolean;
  execute(request: BrowserAutomationExecuteRequest): Promise<BrowserToolsResponsePayload>;
}

/**
 * Decides which browser serves an MCP browser command.
 *
 * Switch on: new tabs always open in the server browser, so an agent's tab survives the laptop
 * closing and every client can watch it. A tab the server browser owns stays there; any other
 * browserId (an app tab opened before the switch) goes to the app broker as before.
 * Switch off: everything goes to the broker, unchanged.
 */
export class ServerBrowserRouter {
  public constructor(
    private readonly broker: Pick<BrowserToolsBroker, "execute">,
    private readonly server: ServerBrowserCommandTarget,
  ) {}

  public async execute(input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> {
    if (!this.server.isEnabled()) return this.broker.execute(input);
    const command = input.command;
    if (command.command === "list_tabs") return this.listTabs(input);
    if (command.command === "new_tab" || this.server.ownsTab(command.args.browserId)) {
      return this.executeOnServer(input);
    }
    return this.broker.execute(input);
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
    const [server, app] = await Promise.all([
      this.executeOnServer(input),
      this.broker.execute(input),
    ]);
    if (!server.ok) return server;
    const serverTabs = server.result.command === "list_tabs" ? server.result.tabs : [];
    // No app connected is normal once the browser lives on the server.
    const appTabs = app.ok && app.result.command === "list_tabs" ? app.result.tabs : [];
    return {
      requestId: server.requestId,
      ok: true,
      result: { command: "list_tabs", tabs: [...serverTabs, ...appTabs] },
    };
  }
}
