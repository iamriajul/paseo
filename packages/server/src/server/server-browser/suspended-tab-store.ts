import { chmod, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-file.js";
import type { ServerBrowserViewport, SuspendedTabRecord } from "./server-browser-tab.js";

/** A suspended tab as it survives a daemon restart. */
export interface StoredSuspendedTab extends SuspendedTabRecord {
  browserId: string;
  workspaceId: string;
  openedBy: "agent" | "user";
  viewport: ServerBrowserViewport;
  openerBrowserId?: string;
  /** A user pinned it: it never closes by the suspended-tab cap or age. */
  pinned?: boolean;
}

interface SuspendedTabFile {
  version: 1;
  browserId: string;
  workspaceId: string;
  openedBy: "agent" | "user";
  url: string;
  title: string;
  viewport: ServerBrowserViewport;
  openerBrowserId?: string;
  pinned?: boolean;
  createdAt: number;
  lastUsedAt: number;
  suspendedAt: number;
  scroll: { x: number; y: number };
  frame: { width: number; height: number; jpegBase64: string } | null;
}

const BROWSER_ID = /^[A-Za-z0-9-]{1,80}$/;

/**
 * One JSON file per suspended tab, frame included, in a directory only the daemon's user can
 * read: the frame shows whatever the page showed, signed-in pages included.
 */
export class SuspendedTabStore {
  public constructor(private readonly directory: string) {}

  public async save(tab: StoredSuspendedTab): Promise<void> {
    if (!BROWSER_ID.test(tab.browserId)) return;
    const { suspension } = tab;
    const file: SuspendedTabFile = {
      version: 1,
      browserId: tab.browserId,
      workspaceId: tab.workspaceId,
      openedBy: tab.openedBy,
      url: tab.url,
      title: tab.title,
      viewport: tab.viewport,
      ...(tab.openerBrowserId ? { openerBrowserId: tab.openerBrowserId } : {}),
      ...(tab.pinned ? { pinned: true } : {}),
      createdAt: tab.createdAt,
      lastUsedAt: tab.lastUsedAt,
      suspendedAt: suspension.suspendedAt,
      scroll: suspension.scroll,
      frame: suspension.frame
        ? {
            width: suspension.frame.width,
            height: suspension.frame.height,
            jpegBase64: Buffer.from(suspension.frame.jpeg).toString("base64"),
          }
        : null,
    };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await writeFileAtomic(this.file(tab.browserId), JSON.stringify(file));
  }

  public async remove(browserId: string): Promise<void> {
    if (!BROWSER_ID.test(browserId)) return;
    await rm(this.file(browserId), { force: true });
  }

  public async clear(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }

  /** Every readable record; a file that does not parse is deleted. */
  public async loadAll(): Promise<StoredSuspendedTab[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return [];
    }
    const tabs: StoredSuspendedTab[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const path = join(this.directory, name);
      const tab = parse(await readFile(path, "utf8").catch(() => ""));
      if (tab) tabs.push(tab);
      else await rm(path, { force: true });
    }
    return tabs;
  }

  private file(browserId: string): string {
    return join(this.directory, `${browserId}.json`);
  }
}

function parse(raw: string): StoredSuspendedTab | null {
  let file: Partial<SuspendedTabFile>;
  try {
    file = JSON.parse(raw) as Partial<SuspendedTabFile>;
  } catch {
    return null;
  }
  if (
    file.version !== 1 ||
    typeof file.browserId !== "string" ||
    !BROWSER_ID.test(file.browserId) ||
    typeof file.workspaceId !== "string" ||
    typeof file.url !== "string" ||
    typeof file.lastUsedAt !== "number" ||
    typeof file.suspendedAt !== "number" ||
    !file.viewport
  ) {
    return null;
  }
  return {
    browserId: file.browserId,
    workspaceId: file.workspaceId,
    openedBy: file.openedBy === "user" ? "user" : "agent",
    url: file.url,
    title: typeof file.title === "string" ? file.title : "",
    viewport: file.viewport,
    ...(file.openerBrowserId ? { openerBrowserId: file.openerBrowserId } : {}),
    ...(file.pinned === true ? { pinned: true } : {}),
    createdAt: typeof file.createdAt === "number" ? file.createdAt : file.suspendedAt,
    lastUsedAt: file.lastUsedAt,
    suspension: {
      suspendedAt: file.suspendedAt,
      scroll: file.scroll ?? { x: 0, y: 0 },
      frame: file.frame
        ? {
            jpeg: Buffer.from(file.frame.jpegBase64, "base64"),
            width: file.frame.width,
            height: file.frame.height,
          }
        : null,
    },
  };
}
