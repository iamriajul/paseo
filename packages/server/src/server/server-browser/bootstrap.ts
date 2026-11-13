import type { Logger } from "pino";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { effectiveChromeMode, type ServerBrowserEngineConfig } from "./engines.js";
import { resolveNewTabTargetSetting } from "./router.js";
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
    ...tabIdleFromEnv(process.env.PASEO_SERVER_BROWSER_TAB_IDLE_MS),
    ...(params.resolveWorkspaceName ? { resolveWorkspaceName: params.resolveWorkspaceName } : {}),
  });
  void host.loadSuspendedTabs().catch((error) => {
    logger.warn({ err: error }, "Server browser: suspended tabs not restored");
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
    browserToolsBroker: new ServerBrowserRoutingBroker({}, host, () =>
      resolveNewTabTargetSetting(read()?.newTabTarget),
    ),
    stopServerBrowser: async () => {
      unsubscribe();
      await host.shutdown();
    },
  };
}

/** `PASEO_SERVER_BROWSER_TAB_IDLE_MS` overrides how long an untouched tab stays loaded. */
export function tabIdleFromEnv(value: string | undefined): { limits?: { tabIdleMs: number } } {
  const ms = Number(value);
  return value && Number.isFinite(ms) && ms >= 1_000 ? { limits: { tabIdleMs: ms } } : {};
}

/** The config row; the index signature matches the protocol schema's passthrough. */
interface ServerBrowserSetting {
  [key: string]: unknown;
  enabled?: boolean;
  executablePath?: string;
  engine?: string;
  cdpUrl?: string;
  chromeMode?: string;
  newTabTarget?: string;
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
    ...(persisted?.newTabTarget ? { newTabTarget: persisted.newTabTarget } : {}),
  };
}

/** A switch turned on before engines existed, or an engine this daemon does not know: Headless (light). */
export function resolveServerBrowserEngine(
  setting: ServerBrowserSetting | undefined,
  platform: NodeJS.Platform = process.platform,
): ServerBrowserEngineConfig {
  const kind = setting?.engine;
  if (kind === "managed-chrome") {
    const requested = setting?.chromeMode === "headless" ? "headless" : "window";
    return { kind, chromeMode: effectiveChromeMode(requested, platform) };
  }
  if (kind === "existing") {
    return { kind, ...(setting?.cdpUrl ? { cdpUrl: setting.cdpUrl } : {}) };
  }
  return {
    kind: "headless",
    ...(setting?.executablePath ? { executablePath: setting.executablePath } : {}),
  };
}
