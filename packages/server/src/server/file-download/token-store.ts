import { randomUUID } from "node:crypto";

interface FileDownloadTarget {
  kind: "file";
  path: string;
  absolutePath: string;
  fileName: string;
  mimeType: string;
  size: number;
}

/** A folder downloads as a zip the daemon builds while it streams (see folder-zip.ts). */
interface FolderDownloadTarget {
  kind: "folder";
  path: string;
  /** Canonical folder path. */
  absolutePath: string;
  /** Canonical workspace root: no entry outside it goes into the zip. */
  rootPath: string;
  fileName: string;
  includeHidden: boolean;
}

export type DownloadTokenTarget = FileDownloadTarget | FolderDownloadTarget;

interface DownloadTokenMetadata {
  token: string;
  expiresAt: number;
}

export type DownloadTokenEntry = DownloadTokenTarget & DownloadTokenMetadata;

interface DownloadTokenStoreOptions {
  ttlMs: number;
  now?: () => number;
}

export class DownloadTokenStore {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly tokens = new Map<string, DownloadTokenEntry>();

  constructor(options: DownloadTokenStoreOptions) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? (() => Date.now());
  }

  issueToken<T extends DownloadTokenTarget>(input: T): T & DownloadTokenMetadata {
    this.pruneExpired();
    const token = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    const entry = {
      ...input,
      token,
      expiresAt,
    };
    this.tokens.set(token, entry);
    return entry;
  }

  consumeToken(token: string): DownloadTokenEntry | null {
    const entry = this.tokens.get(token);
    if (!entry) {
      return null;
    }

    this.tokens.delete(token);

    if (entry.expiresAt <= this.now()) {
      return null;
    }

    return entry;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= now) {
        this.tokens.delete(token);
      }
    }
  }
}
