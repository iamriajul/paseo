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

/**
 * A macOS or Windows host has no X display for Window mode and runs Managed Chrome headless
 * whatever is saved (`features.serverBrowserChromeHeadlessOnly`), so Settings offers no choice there.
 */
export const MANAGED_CHROME_HEADLESS_ONLY_HINT =
  "Chrome runs headless on this host, without a window, and some sites may spot it. Window mode needs an X display, which only Linux hosts have.";

/** The hint under Managed Chrome: the picked mode's, or why a macOS or Windows host has no choice. */
export function describeManagedChromeMode(params: {
  mode: ManagedChromeMode;
  headlessOnly: boolean;
}): string {
  if (params.headlessOnly) return MANAGED_CHROME_HEADLESS_ONLY_HINT;
  return MANAGED_CHROME_MODES.find((entry) => entry.mode === params.mode)?.description ?? "";
}

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

/** Where an agent's new tab opens when it does not pass `target` (`serverBrowser.newTabTarget`). */
export type NewTabTarget = "auto" | "server" | "desktop";

export const NEW_TAB_TARGETS: ReadonlyArray<{
  target: NewTabTarget;
  label: string;
  description: string;
}> = [
  {
    target: "auto",
    label: "Automatic",
    description:
      "The desktop app's Browser while a desktop app is connected, otherwise the server browser. An agent can still pick either.",
  },
  {
    target: "server",
    label: "Server",
    description:
      "Always the server browser, which keeps working with every app closed. An agent can still ask for the desktop app's Browser.",
  },
  {
    target: "desktop",
    label: "Desktop",
    description:
      "Always the desktop app's Browser; a new tab fails while no desktop app is connected. An agent can still ask for the server browser.",
  },
];

export const NEW_TAB_TARGET_TITLE = "Default browser for agents' new tabs";

/** The row's hint: what the choice does, and what the server browser switch changes about it. */
export function describeNewTabTarget(params: {
  target: NewTabTarget;
  serverBrowserEnabled: boolean;
}): string {
  if (!params.serverBrowserEnabled && params.target === "server") {
    return "Server is unavailable while the server-side browser is off, so agents' new tabs fail until you turn it on or pick Automatic or Desktop.";
  }
  if (!params.serverBrowserEnabled && params.target === "auto") {
    return "The server-side browser is off, so Automatic opens agents' new tabs in the desktop app's Browser. Server is unavailable until you turn it on.";
  }
  return NEW_TAB_TARGETS.find((entry) => entry.target === params.target)?.description ?? "";
}

export function resolveNewTabTarget(setting: { newTabTarget?: string } | undefined): NewTabTarget {
  const value = setting?.newTabTarget;
  return value === "server" || value === "desktop" ? value : "auto";
}

/**
 * Carries the switch's current value: the daemon parses a partial `serverBrowser` patch with
 * `enabled` defaulting to false, so leaving it out would turn the server browser off.
 */
export function createNewTabTargetPatch(params: {
  target: NewTabTarget;
  serverBrowserEnabled: boolean;
}): Partial<MutableDaemonConfig> {
  return {
    serverBrowser: { enabled: params.serverBrowserEnabled, newTabTarget: params.target },
  };
}
