import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

export const SERVER_BROWSER_INSTALL_COMMAND = "npx playwright install chromium-headless-shell";

export type ChromiumPlatform = "linux" | "darwin" | "win32";

export interface ChromiumExecutableSearch {
  configuredPath?: string | null;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** The host whose layout to search; paths, PATH delimiter and file names follow it. */
  platform?: ChromiumPlatform;
  isExecutable?: (path: string) => Promise<boolean>;
  listDirectory?: (path: string) => Promise<string[]>;
  /**
   * Where `PLAYWRIGHT_BROWSERS_PATH=0` installs put browsers: playwright-core/.local-browsers.
   * Null when no playwright-core is resolvable from the daemon.
   */
  hermeticBrowsersDir?: () => string | null;
}

/** `PLAYWRIGHT_BROWSERS_PATH=0`: Playwright keeps browsers inside its own package. */
const HERMETIC_SENTINEL = "0";

export type ChromiumExecutableResolution =
  | { ok: true; path: string; source: "config" | "env" | "playwright" | "system" }
  | { ok: false; message: string };

/**
 * Finds a Chromium the daemon may launch as its own instance. Never an existing browser to attach
 * to: the result is always spawned with a profile under PASEO_HOME.
 */
export async function resolveChromiumExecutable(
  search: ChromiumExecutableSearch = {},
): Promise<ChromiumExecutableResolution> {
  const env = search.env ?? process.env;
  const host = search.platform ?? currentPlatform();
  const paths = host === "win32" ? path.win32 : path.posix;
  const isExecutable = search.isExecutable ?? defaultIsExecutable;
  const listDirectory = search.listDirectory ?? defaultListDirectory;

  const explicit = await resolveExplicitExecutable({
    configured: search.configuredPath?.trim(),
    fromEnv: env.PASEO_SERVER_BROWSER_EXECUTABLE?.trim(),
    isExecutable,
  });
  if (explicit) return explicit;

  const hermetic = env.PLAYWRIGHT_BROWSERS_PATH?.trim() === HERMETIC_SENTINEL;
  const cacheDir = hermetic
    ? (search.hermeticBrowsersDir ?? defaultHermeticBrowsersDir)()
    : playwrightCacheDir({ env, home: search.home ?? homedir(), host, paths });
  const fromPlaywright = cacheDir
    ? await findInPlaywrightCache({ cacheDir, host, paths, isExecutable, listDirectory })
    : null;
  if (fromPlaywright) return { ok: true, path: fromPlaywright, source: "playwright" };

  const fromPath = await findOnPath({ env, host, paths, isExecutable });
  if (fromPath) return { ok: true, path: fromPath, source: "system" };

  return { ok: false, message: notFoundMessage(hermetic) };
}

async function findInPlaywrightCache(params: {
  cacheDir: string;
  host: ChromiumPlatform;
  paths: path.PlatformPath;
  isExecutable: (path: string) => Promise<boolean>;
  listDirectory: (path: string) => Promise<string[]>;
}): Promise<string | null> {
  const { cacheDir, host, paths, isExecutable, listDirectory } = params;
  const entries = await listDirectory(cacheDir);
  for (const candidate of playwrightCandidates({ cacheDir, entries, host, paths })) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function findOnPath(params: {
  env: NodeJS.ProcessEnv;
  host: ChromiumPlatform;
  paths: path.PlatformPath;
  isExecutable: (path: string) => Promise<boolean>;
}): Promise<string | null> {
  const { env, host, paths, isExecutable } = params;
  const pathDirs = (env.PATH ?? env.Path ?? "").split(paths.delimiter).filter(Boolean);
  for (const name of systemBrowserNames(host)) {
    for (const dir of pathDirs) {
      const candidate = paths.join(dir, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function notFoundMessage(hermetic: boolean): string {
  if (hermetic) {
    // The install command would put the browser back inside some project's playwright-core.
    return `No Chromium found for the server browser. The daemon runs with PLAYWRIGHT_BROWSERS_PATH=0, so Playwright installs browsers inside each project's own node_modules, where the daemon does not look. Unset PLAYWRIGHT_BROWSERS_PATH for the daemon and run \`${SERVER_BROWSER_INSTALL_COMMAND}\` as the user it runs as, or set serverBrowser.executablePath in config.json.`;
  }
  return `No Chromium found for the server browser. Install one on the daemon host with \`${SERVER_BROWSER_INSTALL_COMMAND}\` (run as the user the daemon runs as), or set serverBrowser.executablePath in config.json.`;
}

function defaultHermeticBrowsersDir(): string | null {
  try {
    const manifest = createRequire(import.meta.url).resolve("playwright-core/package.json");
    return path.join(path.dirname(manifest), ".local-browsers");
  } catch {
    return null;
  }
}

/** A path the user named wins, and a wrong one is reported rather than silently replaced. */
async function resolveExplicitExecutable(params: {
  configured: string | undefined;
  fromEnv: string | undefined;
  isExecutable: (path: string) => Promise<boolean>;
}): Promise<ChromiumExecutableResolution | null> {
  const { configured, fromEnv, isExecutable } = params;
  if (configured) {
    return (await isExecutable(configured))
      ? { ok: true, path: configured, source: "config" }
      : {
          ok: false,
          message: `The configured server browser executable ${configured} does not exist or is not executable.`,
        };
  }
  if (fromEnv) {
    return (await isExecutable(fromEnv))
      ? { ok: true, path: fromEnv, source: "env" }
      : {
          ok: false,
          message: `PASEO_SERVER_BROWSER_EXECUTABLE=${fromEnv} does not exist or is not executable.`,
        };
  }
  return null;
}

function currentPlatform(): ChromiumPlatform {
  if (process.platform === "win32" || process.platform === "darwin") return process.platform;
  return "linux";
}

function systemBrowserNames(host: ChromiumPlatform): string[] {
  const names = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];
  return host === "win32" ? ["chrome.exe", "chromium.exe", "msedge.exe"] : names;
}

/** Playwright's shared cache: PLAYWRIGHT_BROWSERS_PATH (not the "0" sentinel), else per OS. */
function playwrightCacheDir(params: {
  env: NodeJS.ProcessEnv;
  home: string;
  host: ChromiumPlatform;
  paths: path.PlatformPath;
}): string {
  const { env, home, host, paths } = params;
  const configured = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (configured) return configured;
  if (host === "darwin") return paths.join(home, "Library", "Caches", "ms-playwright");
  if (host === "win32") {
    return paths.join(
      env.LOCALAPPDATA?.trim() || paths.join(home, "AppData", "Local"),
      "ms-playwright",
    );
  }
  return paths.join(env.XDG_CACHE_HOME?.trim() || paths.join(home, ".cache"), "ms-playwright");
}

/** Executable layouts inside a revision directory, per OS: headless shell first, then Chromium. */
const LAYOUTS: Record<ChromiumPlatform, { shell: string[][]; full: string[][] }> = {
  linux: {
    shell: [
      ["chrome-headless-shell-linux64", "chrome-headless-shell"],
      ["chrome-linux", "headless_shell"],
    ],
    full: [
      ["chrome-linux64", "chrome"],
      ["chrome-linux", "chrome"],
    ],
  },
  darwin: {
    shell: [
      ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
      ["chrome-headless-shell-mac-x64", "chrome-headless-shell"],
      // Playwright 1.49-1.56 extracted the shell under its legacy directory name.
      ["chrome-mac", "headless_shell"],
    ],
    full: [
      [
        "chrome-mac-arm64",
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing",
      ],
      [
        "chrome-mac-x64",
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing",
      ],
      ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ],
  },
  win32: {
    shell: [
      ["chrome-headless-shell-win64", "chrome-headless-shell.exe"],
      // Playwright 1.49-1.56 extracted the shell under its legacy directory name.
      ["chrome-win", "headless_shell.exe"],
    ],
    full: [
      ["chrome-win64", "chrome.exe"],
      ["chrome-win", "chrome.exe"],
    ],
  },
};

/** Newest headless shell first, then newest full Chromium. */
function playwrightCandidates(params: {
  cacheDir: string;
  entries: string[];
  host: ChromiumPlatform;
  paths: path.PlatformPath;
}): string[] {
  const { cacheDir, entries, host, paths } = params;
  const byRevision = (prefix: string) =>
    entries
      .filter((entry) => entry.startsWith(prefix) && /-\d+$/.test(entry))
      .sort((a, b) => revision(b) - revision(a));
  const layout = LAYOUTS[host];
  const expand = (dirs: string[], layouts: string[][]) =>
    dirs.flatMap((dir) => layouts.map((parts) => paths.join(cacheDir, dir, ...parts)));
  return [
    ...expand(byRevision("chromium_headless_shell-"), layout.shell),
    ...expand(byRevision("chromium-"), layout.full),
  ];
}

function revision(entry: string): number {
  return Number(entry.slice(entry.lastIndexOf("-") + 1));
}

async function defaultIsExecutable(candidate: string): Promise<boolean> {
  try {
    // Windows has no execute bit; existence is the check there.
    await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultListDirectory(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

/**
 * Real Google Chrome for the Managed Chrome engine: Google sign-in and bot checks treat it as a
 * normal browser, which Playwright's builds are not. Chromium is the fallback.
 */
export async function resolveChromeExecutable(
  search: Pick<ChromiumExecutableSearch, "env" | "platform" | "isExecutable"> = {},
): Promise<ChromiumExecutableResolution> {
  const env = search.env ?? process.env;
  const host = search.platform ?? currentPlatform();
  const paths = host === "win32" ? path.win32 : path.posix;
  const isExecutable = search.isExecutable ?? defaultIsExecutable;
  const fromEnv = env.PASEO_SERVER_BROWSER_CHROME?.trim();
  if (fromEnv) {
    return (await isExecutable(fromEnv))
      ? { ok: true, path: fromEnv, source: "env" }
      : { ok: false, message: `PASEO_SERVER_BROWSER_CHROME is not an executable: ${fromEnv}` };
  }
  for (const installed of chromeInstallPaths(host, env)) {
    if (await isExecutable(installed)) return { ok: true, path: installed, source: "system" };
  }
  const pathDirs = (env.PATH ?? env.Path ?? "").split(paths.delimiter).filter(Boolean);
  const names =
    host === "win32"
      ? ["chrome.exe"]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const name of names) {
    for (const dir of pathDirs) {
      const candidate = paths.join(dir, name);
      if (await isExecutable(candidate)) return { ok: true, path: candidate, source: "system" };
    }
  }
  return { ok: false, message: CHROME_MISSING[host] };
}

const CHROME_MISSING: Record<ChromiumPlatform, string> = {
  linux:
    "Managed Chrome needs Google Chrome on this host (google-chrome on PATH, or PASEO_SERVER_BROWSER_CHROME).",
  darwin:
    "Managed Chrome needs Google Chrome on this host (Google Chrome.app in /Applications or ~/Applications, or PASEO_SERVER_BROWSER_CHROME).",
  win32:
    "Managed Chrome needs Google Chrome on this host (installed for all users or for this user, or PASEO_SERVER_BROWSER_CHROME).",
};

/**
 * Where Google Chrome's installers put it. Windows never adds chrome.exe to PATH: a system-wide
 * install goes under Program Files (Program Files (x86) for older 32-bit ones), a per-user one
 * under LOCALAPPDATA. macOS installs the app bundle in /Applications, or ~/Applications for one user.
 */
function chromeInstallPaths(host: ChromiumPlatform, env: NodeJS.ProcessEnv): string[] {
  if (host === "darwin") {
    const bundle = "Google Chrome.app/Contents/MacOS/Google Chrome";
    const home = env.HOME?.trim();
    return [
      `/Applications/${bundle}`,
      ...(home ? [path.posix.join(home, "Applications", bundle)] : []),
    ];
  }
  if (host === "win32") {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]
      .map((root) => root?.trim())
      .filter((root): root is string => Boolean(root));
    return roots.map((root) =>
      path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe"),
    );
  }
  return [];
}
