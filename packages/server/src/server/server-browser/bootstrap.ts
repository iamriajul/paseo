import type { Logger } from "pino";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type { ServerBrowserEngineConfig } from "./engines.js";
import { ServerBrowserRoutingBroker } from "./routing-broker.js";
import { ServerBrowserHost } from "./server-browser-host.js";

/** Daemon wiring: the routing broker, its host, and the switch's live config. */
export function createServerBrowser(params: {
  paseoHome: string;
  logger: Logger;
  daemonConfigStore: Pick<DaemonConfigStore, "get" | "onChange">;
  resolveWorkspaceName?: (workspaceId: string) => Promise<string | null>;
}): { browserToolsBroker: ServerBrowserRoutingBroker; stopServerBrowser: () => Promise<void> } {
  const logger = params.logger.child({ module: "server-browser" });
  const read = () => params.daemonConfigStore.get().serverBrowser;
  const host = new ServerBrowserHost({
    paseoHome: params.paseoHome,
    logger,
    isEnabled: () => read()?.enabled === true,
    getEngine: () => resolveServerBrowserEngine(read()),
    ...(params.resolveWorkspaceName ? { resolveWorkspaceName: params.resolveWorkspaceName } : {}),
  });
  let wasEnabled = host.isEnabled();
  let engineKey = JSON.stringify(host.engineConfig());
  const unsubscribe = params.daemonConfigStore.onChange(() => {
    const enabled = host.isEnabled();
    const nextEngineKey = JSON.stringify(host.engineConfig());
    const engineChanged = nextEngineKey !== engineKey;
    engineKey = nextEngineKey;
    if (enabled === wasEnabled && !engineChanged) return;
    wasEnabled = enabled;
    logger.info({ enabled, engine: host.engineConfig().kind }, "Server browser setting changed");
    // A different engine means a different browser: close this one's tabs; the next tab starts it.
    if (enabled && !engineChanged) host.notifyStatusChanged();
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

/** The config row; the index signature matches the protocol schema's passthrough. */
interface ServerBrowserSetting {
  [key: string]: unknown;
  enabled?: boolean;
  executablePath?: string;
  engine?: string;
  cdpUrl?: string;
  chromeMode?: string;
}

export function resolveInitialServerBrowserConfig(
  persisted: ServerBrowserSetting | undefined,
): ServerBrowserSetting & { enabled: boolean } {
  return {
    enabled: persisted?.enabled ?? false,
    ...(persisted?.executablePath ? { executablePath: persisted.executablePath } : {}),
    ...(persisted?.engine ? { engine: persisted.engine } : {}),
    ...(persisted?.cdpUrl ? { cdpUrl: persisted.cdpUrl } : {}),
    ...(persisted?.chromeMode ? { chromeMode: persisted.chromeMode } : {}),
  };
}

/** A switch turned on before engines existed, or an engine this daemon does not know: Headless (light). */
export function resolveServerBrowserEngine(
  setting: ServerBrowserSetting | undefined,
): ServerBrowserEngineConfig {
  const kind = setting?.engine;
  if (kind === "managed-chrome") {
    return { kind, chromeMode: setting?.chromeMode === "headless" ? "headless" : "window" };
  }
  if (kind === "existing") {
    return { kind, ...(setting?.cdpUrl ? { cdpUrl: setting.cdpUrl } : {}) };
  }
  return {
    kind: "headless",
    ...(setting?.executablePath ? { executablePath: setting.executablePath } : {}),
  };
}
