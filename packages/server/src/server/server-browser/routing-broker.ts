import {
  BrowserToolsBroker,
  type BrowserToolsBrokerOptions,
  type BrowserToolsExecuteInput,
} from "../browser-tools/broker.js";
import type { BrowserToolsResponsePayload } from "../browser-tools/errors.js";
import { ServerBrowserRouter } from "./router.js";
import type { ServerBrowserHost } from "./server-browser-host.js";

/**
 * The broker the daemon hands to MCP tools and sessions. It is the upstream broker plus the
 * server browser: subclassing keeps every upstream call site unchanged while the router decides
 * where each command runs.
 */
export class ServerBrowserRoutingBroker extends BrowserToolsBroker {
  private readonly router: ServerBrowserRouter;

  public constructor(
    options: BrowserToolsBrokerOptions,
    public readonly serverBrowser: ServerBrowserHost,
  ) {
    super(options);
    this.router = new ServerBrowserRouter(
      { execute: (input) => super.execute(input) },
      serverBrowser,
    );
  }

  public override execute(input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> {
    return this.router.execute(input);
  }
}

export function serverBrowserOf(
  broker: BrowserToolsBroker | null | undefined,
): ServerBrowserHost | null {
  return broker instanceof ServerBrowserRoutingBroker ? broker.serverBrowser : null;
}
