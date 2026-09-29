import type { TerminalManager, TerminalManagerOptions } from "./terminal-manager.js";
import { createWorkerTerminalManager } from "./worker-terminal-manager.js";

export type ConfiguredTerminalManagerOptions = TerminalManagerOptions;

export function createConfiguredTerminalManager(
  options: ConfiguredTerminalManagerOptions = {},
): TerminalManager {
  return createWorkerTerminalManager(options);
}
