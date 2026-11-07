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

export class CdpConnectionClosedError extends Error {
  public constructor() {
    super("The server browser closed");
    this.name = "CdpConnectionClosedError";
  }
}

interface PendingCall {
  method: string;
  resolve: (value: CdpParams) => void;
  reject: (error: Error) => void;
}

/**
 * CDP over --remote-debugging-pipe: fd 3 carries commands to Chromium, fd 4 carries replies and
 * events, each message NUL-terminated. No TCP debug port exists, and Chromium exits when the
 * daemon's end of the pipe closes, so a killed daemon cannot leave an orphan browser.
 */
export class CdpConnection extends EventEmitter<{
  event: [CdpEvent];
  close: [];
}> {
  private nextId = 0;
  private readonly pending = new Map<number, PendingCall>();
  private buffer = "";
  private closed = false;

  public constructor(
    private readonly writer: Writable,
    reader: Readable,
  ) {
    super();
    reader.setEncoding("utf8");
    reader.on("data", (chunk: string) => this.receive(chunk));
    reader.on("close", () => this.markClosed());
    reader.on("error", () => this.markClosed());
    writer.on("error", () => this.markClosed());
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
      this.writer.write(`${message}\0`);
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let end = this.buffer.indexOf("\0");
    while (end !== -1) {
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      this.dispatch(raw);
      end = this.buffer.indexOf("\0");
    }
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
}

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
    "--headless",
    "--remote-debugging-pipe",
    `--user-data-dir=${options.userDataDir}`,
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
    ...(noSandbox ? ["--no-sandbox"] : []),
    "about:blank",
  ];
  const child = spawn(options.executablePath, args, {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });
  const writer = child.stdio[3] as Writable;
  const reader = child.stdio[4] as Readable;
  const connection = new CdpConnection(writer, reader);

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
