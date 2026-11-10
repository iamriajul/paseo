import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  CdpConnection,
  HEADLESS_SHELL_ARGS,
  ServerBrowserUnavailableError,
  webSocketTransport,
} from "./cdp-connection.js";
import {
  resolveChromeExecutable,
  resolveChromiumExecutable,
  type ChromiumExecutableResolution,
} from "./chromium-executable.js";
import { SharedChromium, type LaunchFn, type SharedChromiumEvents } from "./shared-chromium.js";

/**
 * The engines behind the server browser. Tabs, the viewer and the MCP tools never see which one
 * runs: every engine yields a `SharedChromium` speaking CDP. Adding one means a kind here, its
 * traits, and a branch in `startEngine`.
 */
export type ServerBrowserEngineKind = "headless" | "managed-chrome" | "existing";

export const DEFAULT_EXISTING_BROWSER_URL = "http://127.0.0.1:9222";

export interface ServerBrowserEngineConfig {
  kind: ServerBrowserEngineKind;
  /** Existing browser: its DevTools HTTP endpoint or WebSocket URL. */
  cdpUrl?: string;
  /** Headless (light): an explicit headless shell or Chromium. */
  executablePath?: string;
  /** Managed Chrome: a window on a display (most compatible), or new headless (less memory). */
  chromeMode?: ManagedChromeMode;
}

export type ManagedChromeMode = "window" | "headless";

export interface ServerBrowserEngineTraits {
  /**
   * `context`: each workspace gets a browser context, and the daemon saves its storage.
   * `shared`: every workspace uses the browser's default context and its own persistent profile,
   * so they share one cookie jar.
   */
  isolation: "context" | "shared";
  /** Whether the daemon started the browser and may close it. */
  owned: boolean;
}

export const SERVER_BROWSER_ENGINE_TRAITS: Record<
  ServerBrowserEngineKind,
  ServerBrowserEngineTraits
> = {
  headless: { isolation: "context", owned: true },
  "managed-chrome": { isolation: "shared", owned: true },
  existing: { isolation: "shared", owned: false },
};

/** Where Managed Chrome finds a display: detect one, always start its own Xvfb, or a given one. */
export type DisplayPreference = "auto" | "xvfb" | `:${string}`;

export interface StartEngineParams {
  config: ServerBrowserEngineConfig;
  paseoHome: string;
  noSandbox: boolean;
  events: SharedChromiumEvents;
  launch?: LaunchFn;
  resolveExecutable?: () => Promise<ChromiumExecutableResolution>;
  display?: DisplayPreference;
  onWarning?: (message: string) => void;
}

export async function startEngine(params: StartEngineParams): Promise<SharedChromium> {
  switch (params.config.kind) {
    case "headless":
      return startHeadless(params);
    case "managed-chrome":
      return startManagedChrome(params);
    case "existing":
      return attachExisting(params);
  }
}

async function startHeadless(params: StartEngineParams): Promise<SharedChromium> {
  const resolution = params.resolveExecutable
    ? await params.resolveExecutable()
    : await resolveChromiumExecutable({ configuredPath: params.config.executablePath });
  if (!resolution.ok) throw new Error(resolution.message);
  const root = join(params.paseoHome, "server-browser");
  // The profile only holds Chromium's own bookkeeping: workspace data lives in contexts and the
  // storage files. Start it empty so nothing accumulates across launches.
  const userDataDir = join(root, "chromium");
  await rm(userDataDir, { recursive: true, force: true });
  // COMPAT(server-browser-profiles): v0.15.904 kept a Chromium profile per workspace; remove after 2027-03-01.
  await rm(join(root, "profiles"), { recursive: true, force: true });
  return SharedChromium.launch({
    executablePath: resolution.path,
    userDataDir,
    noSandbox: params.noSandbox,
    args: HEADLESS_SHELL_ARGS,
    events: params.events,
    ...(params.launch ? { launch: params.launch } : {}),
  });
}

/**
 * Set up the way people run a Chrome for CDP by hand: real Chrome, a persistent profile with first-run
 * and metrics pre-answered, headed on an X display, none of Playwright's automation switches.
 * CDP goes over a pipe instead of a port: `navigator.webdriver` reads the same either way once
 * AutomationControlled is off, and a pipe leaves no port for other processes and no orphan.
 */
const MANAGED_CHROME_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  "--disable-dev-shm-usage",
  "--disable-breakpad",
  "--disable-crash-reporter",
  "--disable-metrics",
  // Without it Chrome sets navigator.webdriver for any CDP client, pipe or port alike.
  "--disable-blink-features=AutomationControlled",
  // Invisible to pages; the same memory savings as Headless (light). No --disable-gpu: pages
  // and bot checks expect WebGL.
  "--process-per-site",
  "--js-flags=--optimize-for-size",
];

async function startManagedChrome(params: StartEngineParams): Promise<SharedChromium> {
  const resolution = await resolveChromeExecutable();
  if (!resolution.ok) throw new Error(resolution.message);
  const mode = params.config.chromeMode ?? "window";
  // Each mode is its own Chrome with its own profile and logins, so a session a site flagged as
  // headless never carries into the windowed profile.
  const userDataDir = managedChromeProfileDir(params.paseoHome, mode);
  if (mode === "window") await adoptLegacyChromeProfile(params.paseoHome, userDataDir);
  await prepareChromeProfile(userDataDir);
  if (mode === "headless") {
    return SharedChromium.launch({
      executablePath: resolution.path,
      userDataDir,
      noSandbox: params.noSandbox,
      args: [
        ...MANAGED_CHROME_ARGS,
        "--headless=new",
        // New headless says HeadlessChrome in its UA by design; report what this same Chrome
        // reports in a window. Nothing else is disguised.
        `--user-agent=${await headedUserAgent(resolution.path)}`,
      ],
      newWindowPerTab: true,
      events: params.events,
      ...(params.launch ? { launch: params.launch } : {}),
    });
  }
  const display = await resolveDisplay(params.display ?? displayPreferenceFromEnv());
  if (!display.name) {
    params.onWarning?.("Managed Chrome found no X display and no Xvfb; running it headless");
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (display.name) {
    env.DISPLAY = display.name;
    env.XAUTHORITY = process.env.XAUTHORITY ?? join(homedir(), ".Xauthority");
  }
  const stopDisplay = () => display.server?.kill("SIGTERM");
  try {
    return await SharedChromium.launch({
      executablePath: resolution.path,
      userDataDir,
      noSandbox: params.noSandbox,
      args: [...MANAGED_CHROME_ARGS, ...(display.name ? [] : ["--headless=new"])],
      env,
      newWindowPerTab: display.name !== null,
      onGone: stopDisplay,
      events: params.events,
      ...(params.launch ? { launch: params.launch } : {}),
    });
  } catch (error) {
    stopDisplay();
    throw error;
  }
}

export function managedChromeProfileDir(paseoHome: string, mode: ManagedChromeMode): string {
  return join(paseoHome, "server-browser", `chrome-profile-${mode}`);
}

/** COMPAT(managed-chrome-profile): the first engines build kept one profile; it becomes Window's. Remove after 2027-03-01. */
export async function adoptLegacyChromeProfile(
  paseoHome: string,
  windowDir: string,
): Promise<void> {
  const legacy = join(paseoHome, "server-browser", "chrome-profile");
  if (!(await exists(legacy)) || (await exists(windowDir))) return;
  await rename(legacy, windowDir);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const userAgents = new Map<string, Promise<string>>();

/**
 * The UA a windowed Chrome of this binary reports: Chrome's reduced UA, which carries only the
 * major version and a fixed platform token per OS.
 */
export function headedUserAgent(executablePath: string): Promise<string> {
  let pending = userAgents.get(executablePath);
  if (!pending) {
    pending = new Promise<string>((resolve, reject) => {
      execFile(executablePath, ["--version"], { timeout: 10_000 }, (error, stdout) => {
        const major = /(\d+)\.\d+\.\d+\.\d+/.exec(stdout)?.[1];
        if (error || !major) reject(new Error(`Could not read the Chrome version: ${stdout}`));
        else resolve(reducedUserAgent(major, process.platform));
      });
    });
    pending.catch(() => userAgents.delete(executablePath));
    userAgents.set(executablePath, pending);
  }
  return pending;
}

/** The fixed platform tokens of Chrome's reduced UA. */
const REDUCED_UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "Macintosh; Intel Mac OS X 10_15_7",
  win32: "Windows NT 10.0; Win64; x64",
};

export function reducedUserAgent(major: string, platform: NodeJS.Platform): string {
  const os = REDUCED_UA_PLATFORMS[platform] ?? "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

async function attachExisting(params: StartEngineParams): Promise<SharedChromium> {
  const url = params.config.cdpUrl?.trim() || DEFAULT_EXISTING_BROWSER_URL;
  const webSocketUrl = await resolveWebSocketUrl(url);
  const connection = new CdpConnection(await webSocketTransport(webSocketUrl));
  return SharedChromium.start({ connection, newWindowPerTab: true, events: params.events });
}

async function resolveWebSocketUrl(url: string): Promise<string> {
  if (/^wss?:/.test(url)) return url;
  let version: { webSocketDebuggerUrl?: string };
  try {
    const response = await fetch(new URL("/json/version", url), {
      signal: AbortSignal.timeout(3_000),
    });
    version = (await response.json()) as { webSocketDebuggerUrl?: string };
  } catch {
    throw new ServerBrowserUnavailableError(
      `No browser answers at ${url}. Start Chrome with --remote-debugging-port, or pick another engine.`,
    );
  }
  if (!version.webSocketDebuggerUrl)
    throw new Error(`${url} did not give a DevTools WebSocket URL`);
  return version.webSocketDebuggerUrl;
}

/** Pre-answers first run and metrics, as the runner does, and clears a dead instance's locks. */
export async function prepareChromeProfile(userDataDir: string): Promise<void> {
  await mkdir(join(userDataDir, "Default"), { recursive: true });
  await mergeJson(join(userDataDir, "Local State"), {
    browser: { enabled_labs_experiments: [] },
    distribution: {
      import_bookmarks: false,
      import_history: false,
      skip_first_run_ui: true,
      show_welcome_page: false,
      suppress_first_run_bubble: true,
      suppress_first_run_default_browser_prompt: true,
    },
    first_run_tabs: [],
    metrics_reporting: { enabled: false },
    user_experience_metrics: { reporting_enabled: false },
  });
  await mergeJson(join(userDataDir, "Default", "Preferences"), {
    browser: {
      has_seen_welcome_page: true,
      check_default_browser: false,
      default_browser_infobar_last_declined: 1,
    },
    distribution: { skip_first_run_ui: true, show_welcome_page: false },
    metrics_reporting: { enabled: false },
    // A daemon killed with Chrome leaves "crashed", and Chrome would offer to restore its tabs.
    profile: { exit_type: "Normal", exited_cleanly: true },
    user_experience_metrics: { reporting_enabled: false },
  });
  await writeFile(join(userDataDir, "First Run"), "");
  for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    await rm(join(userDataDir, lock), { force: true });
  }
}

type Json = Record<string, unknown>;

async function mergeJson(file: string, patch: Json): Promise<void> {
  let current: Json = {};
  try {
    current = JSON.parse(await readFile(file, "utf8")) as Json;
  } catch {}
  await writeFile(file, JSON.stringify(deepMerge(current, patch)));
}

function deepMerge(target: Json, patch: Json): Json {
  const out: Json = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    out[key] = isPlainObject(value) && isPlainObject(existing) ? deepMerge(existing, value) : value;
  }
  return out;
}

function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displayPreferenceFromEnv(): DisplayPreference {
  const value = process.env.PASEO_SERVER_BROWSER_DISPLAY?.trim();
  if (value === "xvfb" || value?.startsWith(":")) return value as DisplayPreference;
  return "auto";
}

export interface ResolvedDisplay {
  name: string | null;
  /** An Xvfb the daemon started for this browser; stopped when the browser is gone. */
  server?: ChildProcess;
}

const X11_SOCKET_DIR = "/tmp/.X11-unix";

export async function resolveDisplay(preference: DisplayPreference): Promise<ResolvedDisplay> {
  if (preference.startsWith(":")) return { name: preference };
  if (preference === "auto") {
    const found = await findLiveDisplay();
    if (found) return { name: found };
  }
  return startXvfb().catch(() => ({ name: null }));
}

async function findLiveDisplay(): Promise<string | null> {
  const candidates: string[] = [];
  if (process.env.DISPLAY) candidates.push(process.env.DISPLAY);
  try {
    for (const entry of (await readdir(X11_SOCKET_DIR)).sort()) {
      if (/^X\d+$/.test(entry)) candidates.push(`:${entry.slice(1)}`);
    }
  } catch {}
  for (const display of candidates) {
    const number = /^:(\d+)/.exec(display)?.[1];
    if (number && (await socketAnswers(join(X11_SOCKET_DIR, `X${number}`)))) return display;
  }
  return null;
}

function socketAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1_000, () => done(false));
  });
}

const XVFB_ARGS = ["-displayfd", "3", "-screen", "0", "1920x1080x24", "-nolisten", "tcp"];

/**
 * Starts an Xvfb on a free display number, which Xvfb reports on fd 3 once it is ready.
 * util-linux `setpriv` execs it with a parent-death signal, so a killed daemon takes its Xvfb
 * with it, as the closed pipe does for Chrome. Without `setpriv`, Xvfb stops only on a graceful exit.
 */
export function startXvfb(): Promise<ResolvedDisplay> {
  return spawnXvfb("setpriv", ["--pdeathsig", "KILL", "--", "Xvfb", ...XVFB_ARGS]).catch(
    (error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? spawnXvfb("Xvfb", XVFB_ARGS) : Promise.reject(error),
  );
}

function spawnXvfb(command: string, args: string[]): Promise<ResolvedDisplay> {
  return new Promise((resolve, reject) => {
    const server = spawn(command, args, { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    const output = server.stdio[3] as Readable;
    let text = "";
    const timer = setTimeout(() => {
      server.kill("SIGKILL");
      reject(new Error("Xvfb did not start"));
    }, 5_000);
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
      const number = /(\d+)\s*$/m.exec(text)?.[1];
      if (number && text.includes("\n")) {
        clearTimeout(timer);
        resolve({ name: `:${number}`, server });
      }
    });
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Xvfb exited"));
    });
  });
}
