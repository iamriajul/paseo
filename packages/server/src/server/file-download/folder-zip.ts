import { constants, promises as fs, type Dirent, type Stats } from "node:fs";
import { finished } from "node:stream/promises";
import path from "node:path";
import type { PassThrough, Readable } from "node:stream";
import { ZipFile } from "yazl";
import { expandUserPath, resolvePathFromBase } from "../path-utils.js";

const FOLDER_OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

export const FOLDER_ZIP_MIME_TYPE = "application/zip";

// Deflate runs on the daemon's CPU while the client waits, so the zip uses level 1: on source
// text it is about three times faster than zlib's default for ~6% more bytes. Formats that are
// already compressed are stored, since deflate cannot shrink them and still costs the full pass.
const STORED_EXTENSIONS = new Set([
  ".7z",
  ".avif",
  ".br",
  ".bz2",
  ".gif",
  ".gz",
  ".heic",
  ".jar",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".ogg",
  ".png",
  ".rar",
  ".tgz",
  ".webm",
  ".webp",
  ".xz",
  ".zip",
  ".zst",
]);

export interface DownloadableFolder {
  /** Workspace-relative path, `.` for the root. */
  path: string;
  absolutePath: string;
  rootPath: string;
  /** `<folder name>.zip`; the workspace folder's name for the root. */
  fileName: string;
}

export interface FolderZipSource {
  absolutePath: string;
  rootPath: string;
  fileName: string;
  /** Files shows dot-named entries only while "show hidden files" is on; the zip follows it. */
  includeHidden: boolean;
}

interface ZippableFile {
  handle: fs.FileHandle;
  stats: Stats;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Resolves a folder the same way single-file download resolves a file: inside the workspace, symlinks resolved. */
export async function getDownloadableFolderInfo({
  root,
  relativePath,
}: {
  root: string;
  relativePath: string;
}): Promise<DownloadableFolder> {
  const workspacePath = expandUserPath(root);
  const rootPath = await fs.realpath(workspacePath);
  const requestedPath = resolvePathFromBase(workspacePath, relativePath);
  if (!isPathInside(workspacePath, requestedPath)) {
    throw new Error("Access outside of workspace is not allowed");
  }
  const absolutePath = await fs.realpath(requestedPath);
  if (!isPathInside(rootPath, absolutePath)) {
    throw new Error("Access outside of workspace is not allowed");
  }
  const stats = await fs.stat(absolutePath);
  if (!stats.isDirectory()) {
    throw new Error("Requested path is not a folder");
  }
  const relative = path.relative(workspacePath, requestedPath);
  const folderName = path.basename(relative === "" ? rootPath : requestedPath) || "folder";
  return {
    path: relative === "" ? "." : relative.split(path.sep).join("/"),
    absolutePath,
    rootPath,
    fileName: `${folderName}.zip`,
  };
}

/** Retried with backoff: the host is short of descriptors or the entry is briefly locked. */
const TRANSIENT_CODES = new Set(["EMFILE", "ENFILE", "EAGAIN", "EBUSY"]);
/** The entry is gone, or Files could not open it either: leave it out of the zip. */
const SKIPPABLE_CODES = new Set([
  "ENOENT",
  "ENOTDIR",
  "EACCES",
  "EPERM",
  "ELOOP",
  "EISDIR",
  "ENXIO",
]);
const RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1600];

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function describeFsError(error: unknown): string {
  const code = errorCode(error);
  if (code === "ENOENT") return "it no longer exists";
  if (code === "EACCES" || code === "EPERM") return "permission denied";
  if (code === "EMFILE" || code === "ENFILE") return "the host has too many open files";
  return error instanceof Error ? error.message : String(error);
}

/** Why a zip stopped, worded for the person who asked for it. */
export class FolderZipError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FolderZipError";
  }
}

async function retryTransient<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || signal.aborted || !TRANSIENT_CODES.has(errorCode(error) ?? "")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * yazl turns `\` into a path separator and then rejects `..` segments and names ending in `/`,
 * so a Linux file named `notes\` would fail the whole zip. Keep such names as one entry.
 */
function zipEntryName(name: string): string {
  return name.replace(/\\/g, "_");
}

/**
 * Streams `source` as a zip. Entries sit under one top folder named after the zip, so unzipping
 * gives back the folder. The walk adds one file at a time and waits for yazl to consume it, so
 * memory and open descriptors stay flat however large the folder is; yazl pipes with
 * backpressure, so a slow reader slows the walk.
 *
 * Contents match what Files lists: every entry, minus dot-named ones unless `includeHidden`.
 * Symlinks to files inside the workspace are zipped as their target's contents; symlinks that
 * leave the workspace, symlinked folders (cycles), dangling links, special files, entries that
 * vanish mid-walk and unreadable entries are skipped. Running out of descriptors is retried, not
 * skipped. Any other failure ends the stream with a FolderZipError that names the entry.
 */
export function createFolderZipStream(
  source: FolderZipSource,
  { signal }: { signal: AbortSignal },
): Readable {
  const zip = new ZipFile();
  // yazl creates outputStream as a PassThrough; its typings only promise NodeJS.ReadableStream.
  const output = zip.outputStream as PassThrough;
  const topFolder = zipEntryName(source.fileName.replace(/\.zip$/i, "")) || "folder";
  zip.on("error", (error: Error) =>
    output.destroy(
      new FolderZipError(`Could not build the zip: ${error.message}`, { cause: error }),
    ),
  );

  async function openRegularFile(absolutePath: string): Promise<ZippableFile | null> {
    const realPath = await fs.realpath(absolutePath);
    if (!isPathInside(source.rootPath, realPath)) return null;
    // stat before open: opening a FIFO for reading blocks until a writer appears.
    if (!(await fs.stat(realPath)).isFile()) return null;
    const handle = await fs.open(realPath, FOLDER_OPEN_FLAGS);
    try {
      const stats = await handle.stat();
      if (stats.isFile()) return { handle, stats };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    await handle.close();
    return null;
  }

  /** Opens a regular file the zip may contain, or returns null to skip the entry. */
  async function openZippableFile(absolutePath: string, zipPath: string) {
    try {
      return await retryTransient(() => openRegularFile(absolutePath), signal);
    } catch (error) {
      if (SKIPPABLE_CODES.has(errorCode(error) ?? "")) return null;
      throw new FolderZipError(`Could not read "${zipPath}": ${describeFsError(error)}`, {
        cause: error,
      });
    }
  }

  async function addFile(absolutePath: string, zipPath: string): Promise<void> {
    const file = await openZippableFile(absolutePath, zipPath);
    if (!file) return;
    const { handle, stats } = file;
    const stream = handle.createReadStream();
    const onAbort = (): void => {
      stream.destroy();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const compress = !STORED_EXTENSIONS.has(path.extname(zipPath).toLowerCase());
      zip.addReadStream(stream, zipPath, {
        mtime: stats.mtime,
        mode: stats.mode,
        compress,
        compressionLevel: compress ? 1 : 0,
      });
      // yazl reads the stream when it reaches this entry; wait so only one file is open.
      await finished(stream);
    } catch (error) {
      stream.destroy();
      if (signal.aborted) return;
      throw new FolderZipError(`Could not read "${zipPath}": ${describeFsError(error)}`, {
        cause: error,
      });
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async function addDirectory(absolutePath: string, zipPath: string, isTop: boolean) {
    let dirents: Dirent[];
    try {
      dirents = await retryTransient(
        () => fs.readdir(absolutePath, { withFileTypes: true }),
        signal,
      );
    } catch (error) {
      if (!isTop && SKIPPABLE_CODES.has(errorCode(error) ?? "")) return;
      throw new FolderZipError(`Could not read "${zipPath}": ${describeFsError(error)}`, {
        cause: error,
      });
    }
    const visible = dirents
      .filter((dirent) => source.includeHidden || !dirent.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (visible.length === 0) {
      zip.addEmptyDirectory(zipPath);
      return;
    }
    for (const dirent of visible) {
      if (signal.aborted) return;
      const childPath = path.join(absolutePath, dirent.name);
      const childZipPath = `${zipPath}/${zipEntryName(dirent.name)}`;
      if (dirent.isDirectory()) {
        await addDirectory(childPath, childZipPath, false);
      } else if (dirent.isFile() || dirent.isSymbolicLink()) {
        await addFile(childPath, childZipPath);
      }
    }
  }

  void (async () => {
    try {
      await addDirectory(source.absolutePath, topFolder, true);
      if (!signal.aborted) zip.end();
    } catch (error) {
      output.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  })();

  return output;
}
