import type { PortForwardController } from "./types";

/**
 * iOS cannot keep forwards alive: opening the user's browser suspends Paseo, and with it the
 * WebSocket every forward rides. See docs/browser-localhost-routing.md#open-on-this-computer.
 */
export function getPortForwardController(): PortForwardController | null {
  return null;
}
