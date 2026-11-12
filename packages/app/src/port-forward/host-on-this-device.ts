import { parseHostPort } from "@getpaseo/protocol/daemon-endpoints";
import type { ActiveConnection } from "@/runtime/host-runtime";
import { isStandardLoopbackHostname } from "@/utils/localhost-url";

/**
 * True when the client reaches the host on this device's own loopback or a local socket: the
 * daemon runs here (on a phone, a daemon in a terminal app), so its ports need no forward.
 * A loopback endpoint that some other tool relays elsewhere (`adb reverse`) reads as local too.
 */
export function isHostOnThisDevice(connection: ActiveConnection | null): boolean {
  if (!connection) return false;
  if (connection.type === "directSocket" || connection.type === "directPipe") return true;
  if (connection.type !== "directTcp") return false;
  try {
    return isStandardLoopbackHostname(parseHostPort(connection.endpoint).host);
  } catch {
    return false;
  }
}
