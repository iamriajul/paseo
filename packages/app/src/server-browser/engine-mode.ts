import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

/**
 * The Settings choice for the server browser. Every mode but Off is an engine the daemon runs tabs
 * in; a switch turned on before engines existed reads as Headless (light).
 */
export type ServerBrowserMode = "off" | "existing" | "managed-chrome" | "headless";

export const SERVER_BROWSER_DEFAULT_CDP_URL = "http://127.0.0.1:9222";

export const SERVER_BROWSER_MODES: ReadonlyArray<{
  mode: ServerBrowserMode;
  label: string;
  description: string;
}> = [
  {
    mode: "off",
    label: "Off",
    description: "Agents' tabs open in a connected app's Browser; nothing runs on this host.",
  },
  {
    mode: "existing",
    label: "Existing browser",
    description:
      "Uses a Chrome already running on this host, with its logins. Every workspace shares its cookies; Paseo only opens and closes its own tabs.",
  },
  {
    mode: "managed-chrome",
    label: "Managed Chrome",
    description:
      "Paseo runs real Google Chrome with its own profiles, so Google sign-in and captchas behave and logins persist. Every workspace shares one cookie jar.",
  },
  {
    mode: "headless",
    label: "Headless (light)",
    description:
      "A light headless Chromium; each workspace keeps its own cookies and storage. Least memory, but some sites block it.",
  },
];

/** Managed Chrome runs in a window or headless; each mode is its own Chrome with its own logins. */
export type ManagedChromeMode = "window" | "headless";

export const MANAGED_CHROME_MODES: ReadonlyArray<{
  mode: ManagedChromeMode;
  label: string;
  description: string;
}> = [
  {
    mode: "window",
    label: "Window (most compatible)",
    description:
      "Chrome runs in a window on a display, as a person's would. Each mode keeps its own logins.",
  },
  {
    mode: "headless",
    label: "Headless (less memory)",
    description:
      "Chrome runs without a window, using less memory; some sites may still spot it. Each mode keeps its own logins.",
  },
];

export function resolveManagedChromeMode(setting: { chromeMode?: string } | undefined) {
  return setting?.chromeMode === "headless" ? "headless" : "window";
}

export function createManagedChromeModePatch(
  mode: ManagedChromeMode,
): Partial<MutableDaemonConfig> {
  return { serverBrowser: { enabled: true, engine: "managed-chrome", chromeMode: mode } };
}

interface ServerBrowserSetting {
  enabled?: boolean;
  engine?: string;
}

export function resolveServerBrowserMode(
  setting: ServerBrowserSetting | undefined,
): ServerBrowserMode {
  if (setting?.enabled !== true) return "off";
  if (setting.engine === "existing" || setting.engine === "managed-chrome") return setting.engine;
  return "headless";
}

/** Turning an engine on also enables browser tools: the server browser only serves agents through them. */
export function createServerBrowserModePatch(
  mode: ServerBrowserMode,
): Partial<MutableDaemonConfig> {
  if (mode === "off") return { serverBrowser: { enabled: false } };
  return { serverBrowser: { enabled: true, engine: mode }, browserTools: { enabled: true } };
}
