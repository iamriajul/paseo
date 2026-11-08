import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-file.js";
import type { CdpEvent, CdpParams } from "./cdp-connection.js";
import type { ChromiumCookie, SharedChromium } from "./shared-chromium.js";

export type LocalStorageItems = Array<[string, string]>;

/**
 * What survives a workspace's browser context closing: cookies (session cookies included) and
 * localStorage per origin. IndexedDB, sessionStorage, Cache Storage and service workers do not.
 */
export interface WorkspaceStorageState {
  version: 1;
  cookies: ChromiumCookie[];
  origins: Record<string, LocalStorageItems>;
}

/** One JSON file per workspace, in a directory only the daemon's user can read: it holds sessions. */
export class WorkspaceStorageStore {
  public constructor(private readonly directory: string) {}

  public async load(workspaceId: string): Promise<WorkspaceStorageState | null> {
    let raw: string;
    try {
      raw = await readFile(this.file(workspaceId), "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<WorkspaceStorageState>;
      if (parsed.version !== 1) return null;
      return {
        version: 1,
        cookies: Array.isArray(parsed.cookies) ? parsed.cookies : [],
        origins: parsed.origins && typeof parsed.origins === "object" ? parsed.origins : {},
      };
    } catch {
      return null;
    }
  }

  public async save(workspaceId: string, serialized: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await writeFileAtomic(this.file(workspaceId), serialized);
  }

  public async remove(workspaceId: string): Promise<void> {
    await rm(this.file(workspaceId), { force: true });
  }

  private file(workspaceId: string): string {
    return join(this.directory, `${sanitizeWorkspaceId(workspaceId)}.json`);
  }
}

export function sanitizeWorkspaceId(workspaceId: string): string {
  return workspaceId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "default";
}

export function originOf(url: string): string | null {
  if (!/^https?:/.test(url)) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const ORIGIN_LOAD_TIMEOUT_MS = 5_000;
const EMPTY_DOCUMENT = Buffer.from("<!doctype html><title></title>").toString("base64");

/**
 * Reads or writes localStorage of origins no tab has open. A hidden page in the workspace's context
 * navigates to each origin with every request answered by an empty document, so the origin's
 * storage is reachable without its server running or its scripts executing. Playwright restores
 * storageState the same way.
 */
export async function withOriginPages<T>(params: {
  chromium: SharedChromium;
  browserContextId: string;
  run: (page: OriginPage) => Promise<T>;
}): Promise<T> {
  const { chromium } = params;
  const target = await chromium.createTarget(params.browserContextId);
  const connection = target.connection;
  const send = (method: string, payload: CdpParams = {}) =>
    connection.send(method, payload, target.sessionId);
  const onEvent = (event: CdpEvent) => {
    if (event.sessionId !== target.sessionId || event.method !== "Fetch.requestPaused") return;
    const requestId = event.params.requestId;
    if (event.params.resourceType === "Document") {
      void send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: "content-type", value: "text/html" }],
        body: EMPTY_DOCUMENT,
      }).catch(() => {});
    } else {
      void send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
    }
  };
  connection.on("event", onEvent);
  try {
    await send("Network.enable");
    await send("Network.setBypassServiceWorker", { bypass: true });
    await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    const evaluate = async (expression: string): Promise<unknown> => {
      const result = (await send("Runtime.evaluate", { expression, returnByValue: true })) as {
        result?: { value?: unknown };
        exceptionDetails?: { text?: string };
      };
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "failed");
      return result.result?.value;
    };
    const page: OriginPage = {
      async open(origin) {
        await send("Page.navigate", { url: `${origin}/` });
        const deadline = Date.now() + ORIGIN_LOAD_TIMEOUT_MS;
        while ((await evaluate("location.origin").catch(() => null)) !== origin) {
          if (Date.now() > deadline) throw new Error(`Could not open ${origin} for its storage`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      },
      async readLocalStorage() {
        const json = await evaluate("JSON.stringify(Object.entries(localStorage))");
        return typeof json === "string" ? (JSON.parse(json) as LocalStorageItems) : [];
      },
      async writeLocalStorage(items) {
        await evaluate(
          `(() => { for (const [k, v] of ${JSON.stringify(items)}) localStorage.setItem(k, v); })()`,
        );
      },
    };
    return await params.run(page);
  } finally {
    connection.off("event", onEvent);
    await chromium.closeTarget(target.targetId);
  }
}

export interface OriginPage {
  open(origin: string): Promise<void>;
  readLocalStorage(): Promise<LocalStorageItems>;
  writeLocalStorage(items: LocalStorageItems): Promise<void>;
}
