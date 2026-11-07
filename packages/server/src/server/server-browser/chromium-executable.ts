import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";

export const SERVER_BROWSER_INSTALL_COMMAND = "npx playwright install chromium-headless-shell";

export interface ChromiumExecutableSearch {
  configuredPath?: string | null;
  env?: NodeJS.ProcessEnv;
  home?: string;
  isExecutable?: (path: string) => Promise<boolean>;
  listDirectory?: (path: string) => Promise<string[]>;
}

export type ChromiumExecutableResolution =
  | { ok: true; path: string; source: "config" | "env" | "playwright" | "system" }
  | { ok: false; message: string };

export class ServerBrowserUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ServerBrowserUnavailableError";
  }
}

/**
 * Finds a Chromium the daemon may launch as its own instance. Never an existing browser to attach
 * to: the result is always spawned with a profile under PASEO_HOME.
 */
export async function resolveChromiumExecutable(
  search: ChromiumExecutableSearch = {},
): Promise<ChromiumExecutableResolution> {
  const env = search.env ?? process.env;
  const isExecutable = search.isExecutable ?? defaultIsExecutable;
  const listDirectory = search.listDirectory ?? defaultListDirectory;

  const configured = search.configuredPath?.trim();
  if (configured) {
    return (await isExecutable(configured))
      ? { ok: true, path: configured, source: "config" }
      : {
          ok: false,
          message: `The configured server browser executable ${configured} does not exist or is not executable.`,
        };
  }
  const fromEnv = env.PASEO_SERVER_BROWSER_EXECUTABLE?.trim();
  if (fromEnv) {
    return (await isExecutable(fromEnv))
      ? { ok: true, path: fromEnv, source: "env" }
      : {
          ok: false,
          message: `PASEO_SERVER_BROWSER_EXECUTABLE=${fromEnv} does not exist or is not executable.`,
        };
  }

  const cacheDir = playwrightCacheDir(env, search.home ?? homedir());
  for (const candidate of playwrightCandidates(cacheDir, await listDirectory(cacheDir))) {
    if (await isExecutable(candidate)) return { ok: true, path: candidate, source: "playwright" };
  }

  for (const name of SYSTEM_BROWSER_NAMES) {
    for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
      const candidate = join(dir, name);
      if (await isExecutable(candidate)) return { ok: true, path: candidate, source: "system" };
    }
  }

  return {
    ok: false,
    message: `No Chromium found for the server browser. Install one on the daemon host with \`${SERVER_BROWSER_INSTALL_COMMAND}\` (run as the user the daemon runs as), or set serverBrowser.executablePath in config.json.`,
  };
}

const SYSTEM_BROWSER_NAMES = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
];

function playwrightCacheDir(env: NodeJS.ProcessEnv, home: string): string {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (configured && configured !== "0") return configured;
  if (platform() === "darwin") return join(home, "Library", "Caches", "ms-playwright");
  return join(env.XDG_CACHE_HOME?.trim() || join(home, ".cache"), "ms-playwright");
}

/** Newest headless shell first, then newest full Chromium. */
function playwrightCandidates(cacheDir: string, entries: string[]): string[] {
  const byRevision = (prefix: string) =>
    entries
      .filter((entry) => entry.startsWith(prefix) && /-\d+$/.test(entry))
      .sort((a, b) => revision(b) - revision(a));
  const shells = byRevision("chromium_headless_shell-").flatMap((dir) => [
    join(cacheDir, dir, "chrome-headless-shell-linux64", "chrome-headless-shell"),
    join(cacheDir, dir, "chrome-linux", "headless_shell"),
    join(cacheDir, dir, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
    join(cacheDir, dir, "chrome-headless-shell-mac-x64", "chrome-headless-shell"),
  ]);
  const full = byRevision("chromium-").flatMap((dir) => [
    join(cacheDir, dir, "chrome-linux64", "chrome"),
    join(cacheDir, dir, "chrome-linux", "chrome"),
  ]);
  return [...shells, ...full];
}

function revision(entry: string): number {
  return Number(entry.slice(entry.lastIndexOf("-") + 1));
}

async function defaultIsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultListDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}
