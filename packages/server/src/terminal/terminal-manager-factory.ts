import type { TerminalManager, TerminalManagerOptions } from "./terminal-manager.js";
import { createWorkerTerminalManager } from "./worker-terminal-manager.js";
import type { TerminalGatewayRouting } from "./harness-routing.js";

export interface ConfiguredTerminalManagerOptions extends TerminalManagerOptions {
  resolveGatewayRouting?: () => TerminalGatewayRouting;
  /** Reports a routing failure that was swallowed so a terminal could still open. */
  onGatewayRoutingError?: (error: unknown) => void;
}

export function createConfiguredTerminalManager(
  options: ConfiguredTerminalManagerOptions = {},
): TerminalManager {
  return createWorkerTerminalManager(options);
}
