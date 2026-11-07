import type { Logger } from "pino";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { ServerBrowserRoutingBroker } from "./routing-broker.js";
import { ServerBrowserHost } from "./server-browser-host.js";

/** Daemon wiring: the routing broker, its host, and the switch's live config. */
export function createServerBrowser(params: {
  paseoHome: string;
  logger: Logger;
  daemonConfigStore: Pick<DaemonConfigStore, "get" | "onChange">;
}): { browserToolsBroker: ServerBrowserRoutingBroker; stopServerBrowser: () => Promise<void> } {
  const logger = params.logger.child({ module: "server-browser" });
  const read = () => params.daemonConfigStore.get().serverBrowser;
  const host = new ServerBrowserHost({
    paseoHome: params.paseoHome,
    logger,
    isEnabled: () => read()?.enabled === true,
    getConfiguredExecutable: () => read()?.executablePath ?? null,
  });
  let wasEnabled = host.isEnabled();
  const unsubscribe = params.daemonConfigStore.onChange(() => {
    const enabled = host.isEnabled();
    if (enabled === wasEnabled) return;
    wasEnabled = enabled;
    logger.info({ enabled }, "Server browser switch changed");
    if (enabled) host.notifyStatusChanged();
    else void host.disable();
  });
  return {
    browserToolsBroker: new ServerBrowserRoutingBroker({}, host),
    stopServerBrowser: async () => {
      unsubscribe();
      await host.shutdown();
    },
  };
}

export function resolveInitialServerBrowserConfig(
  persisted: { enabled?: boolean; executablePath?: string } | undefined,
): { enabled: boolean; executablePath?: string } {
  return {
    enabled: persisted?.enabled ?? false,
    ...(persisted?.executablePath ? { executablePath: persisted.executablePath } : {}),
  };
}
