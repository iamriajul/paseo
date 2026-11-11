import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

export type CdpParams = Record<string, unknown>;

export interface CdpEvent {
  method: string;
  params: CdpParams;
  sessionId?: string;
}

export class CdpError extends Error {
  public constructor(
    public readonly method: string,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = "CdpError";
  }
}

/**
 * The browser is not there to answer: it closed, is not running, or nothing listens at the
 * Existing browser's address. Agents get it as retryable; the next tab starts or reattaches it.
 */
export class ServerBrowserUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ServerBrowserUnavailableError";
  }
}

export class CdpConnectionClosedError extends ServerBrowserUnavailableError {
  public constructor() {
    super("The server browser closed, and its tabs with it. Open a new tab with browser_new_tab.");
    this.name = "CdpConnectionClosedError";
  }
}

interface PendingCall {
  method: string;
  resolve: (value: CdpParams) => void;
  reject: (error: Error) => void;
}

/** Moves CDP messages; a pipe to a Chromium the daemon launched, or a WebSocket to one it found. */
export interface CdpTransport {
  send(message: string): void;
  onMessage(listener: (message: string) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

/**
 * CDP over --remote-debugging-pipe: fd 3 carries commands to Chromium, fd 4 carries replies and
 * events, each message NUL-terminated. No TCP debug port exists, and Chromium exits when the
 * daemon's end of the pipe closes, so a killed daemon cannot leave an orphan browser.
 */
export function pipeTransport(writer: Writable, reader: Readable): CdpTransport {
  let buffer = "";
  const messageListeners: Array<(message: string) => void> = [];
  const closeListeners: Array<() => void> = [];
  const closed = () => {
    for (const listener of closeListeners.splice(0)) listener();
  };
  reader.setEncoding("utf8");
  reader.on("data", (chunk: string) => {
    buffer += chunk;
    let end = buffer.indexOf("\0");
    while (end !== -1) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      for (const listener of messageListeners) listener(raw);
      end = buffer.indexOf("\0");
    }
  });
  reader.on("close", closed);
  reader.on("error", closed);
  writer.on("error", closed);
  return {
    send: (message) => void writer.write(`${message}\0`),
    onMessage: (listener) => void messageListeners.push(listener),
    onClose: (listener) => void closeListeners.push(listener),
    close: () => {
      writer.end();
      reader.destroy();
    },
  };
}

/** CDP over a browser's WebSocket debugger URL, for a browser the daemon did not start. */
export async function webSocketTransport(url: string): Promise<CdpTransport> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new ServerBrowserUnavailableError(`Could not connect to ${url}`)),
      {
        once: true,
      },
    );
  });
  return {
    send: (message) => socket.send(message),
    onMessage: (listener) =>
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") listener(event.data);
      }),
    onClose: (listener) => {
      socket.addEventListener("close", () => listener());
      socket.addEventListener("error", () => listener());
    },
    close: () => socket.close(),
  };
}

export class CdpConnection extends EventEmitter<{
  event: [CdpEvent];
  close: [];
}> {
  private nextId = 0;
  private readonly pending = new Map<number, PendingCall>();
  private closed = false;

  public constructor(private readonly transport: CdpTransport) {
    super();
    transport.onMessage((raw) => this.dispatch(raw));
    transport.onClose(() => this.markClosed());
  }

  /** Ends the connection without asking the browser to do anything. */
  public disconnect(): void {
    this.transport.close();
    this.markClosed();
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public send(method: string, params: CdpParams = {}, sessionId?: string): Promise<CdpParams> {
    if (this.closed) return Promise.reject(new CdpConnectionClosedError());
    const id = ++this.nextId;
    return new Promise<CdpParams>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      const message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
      this.transport.send(message);
    });
  }

  private dispatch(raw: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: CdpParams;
      sessionId?: string;
      result?: CdpParams;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      if (message.error) call.reject(new CdpError(call.method, message.error.message ?? "failed"));
      else call.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === "string") {
      this.emit("event", {
        method: message.method,
        params: message.params ?? {},
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      });
    }
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const call of this.pending.values()) call.reject(new CdpConnectionClosedError());
    this.pending.clear();
    this.emit("close");
  }
}

export interface LaunchedChromium {
  process: ChildProcess;
  connection: CdpConnection;
  sandboxed: boolean;
}

export interface LaunchChromiumOptions {
  executablePath: string;
  userDataDir: string;
  /** Skip the sandbox attempt; set after a launch already found no usable sandbox. */
  noSandbox?: boolean;
  /** The engine's own flags; the pipe, profile and sandbox flags are added here. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

/** Playwright's headless shell, tuned for memory: the Headless (light) engine. */
export const HEADLESS_SHELL_ARGS = [
  "--headless",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-default-apps",
  "--disable-features=Translate,MediaRouter,OptimizationHints",
  "--password-store=basic",
  "--use-mock-keychain",
  "--hide-scrollbars",
  "--mute-audio",
  // Memory, measured with a heavy SPA (docs/server-browser.md#cost). Software compositing
  // without a GPU process saves about 55 MB; V8 sizing its heaps for memory saves about 50 MB
  // per page; same-site tabs of one workspace share a renderer (contexts never share one).
  "--disable-gpu",
  "--process-per-site",
  "--js-flags=--optimize-for-size",
];

const NO_SANDBOX_PATTERN = /No usable sandbox|setuid sandbox|zygote_host_impl/i;
const LAUNCH_TIMEOUT_MS = 15_000;

export class ChromiumLaunchError extends Error {
  public constructor(
    message: string,
    public readonly noUsableSandbox: boolean,
  ) {
    super(message);
    this.name = "ChromiumLaunchError";
  }
}

/** Launches with the sandbox, and once more without it when the kernel offers none. */
export async function launchChromium(options: LaunchChromiumOptions): Promise<LaunchedChromium> {
  if (!options.noSandbox) {
    try {
      return await launchOnce(options, false);
    } catch (error) {
      if (!(error instanceof ChromiumLaunchError) || !error.noUsableSandbox) throw error;
    }
  }
  return launchOnce(options, true);
}

async function launchOnce(
  options: LaunchChromiumOptions,
  noSandbox: boolean,
): Promise<LaunchedChromium> {
  await mkdir(options.userDataDir, { recursive: true });
  const args = [
    "--remote-debugging-pipe",
    `--user-data-dir=${options.userDataDir}`,
    ...(options.args ?? HEADLESS_SHELL_ARGS),
    ...(noSandbox ? ["--no-sandbox"] : []),
    "about:blank",
  ];
  const child = spawn(options.executablePath, args, {
    ...(options.env ? { env: options.env } : {}),
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });
  const writer = child.stdio[3] as Writable;
  const reader = child.stdio[4] as Readable;
  const connection = new CdpConnection(pipeTransport(writer, reader));

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (stderr.length < 8_000) stderr += chunk;
  });

  const exited = new Promise<never>((_, reject) => {
    child.once("error", (error) =>
      reject(new ChromiumLaunchError(`Could not start Chromium: ${error.message}`, false)),
    );
    child.once("exit", (code, signal) =>
      reject(
        new ChromiumLaunchError(
          `Chromium exited during startup (${signal ?? code}): ${lastLines(stderr)}`,
          NO_SANDBOX_PATTERN.test(stderr),
        ),
      ),
    );
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ChromiumLaunchError("Chromium did not answer within 15s", false)),
      LAUNCH_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([connection.send("Browser.getVersion"), exited, timeout]);
  } catch (error) {
    // The pipe usually closes before the exit event; give stderr a moment to explain why.
    await Promise.race([exited.catch(() => {}), delay(1_000)]);
    child.kill("SIGKILL");
    if (NO_SANDBOX_PATTERN.test(stderr)) {
      throw new ChromiumLaunchError(`Chromium has no usable sandbox: ${lastLines(stderr)}`, true);
    }
    throw error instanceof ChromiumLaunchError
      ? error
      : new ChromiumLaunchError(
          `Chromium failed to start: ${error instanceof Error ? error.message : String(error)} ${lastLines(stderr)}`,
          false,
        );
  } finally {
    clearTimeout(timer);
  }
  exited.catch(() => {});
  return { process: child, connection, sandboxed: !noSandbox };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastLines(text: string): string {
  return text.trim().split("\n").slice(-3).join(" ").slice(0, 600);
}
