import type pino from "pino";
import type { OwnedOperation, SessionDelivery } from "../owned-subscriptions/index.js";
import type { FileVersion } from "@getpaseo/protocol/messages";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import {
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type {
  FileDownloadTokenRequest,
  FolderDownloadTokenRequest,
  DownloadCloseRequest,
  DownloadOpenRequest,
  DownloadReadRequest,
  FileEntryCreateRequest,
  FileEntryDeleteRequest,
  FileEntryDuplicateRequest,
  FileEntryRenameRequest,
  FileEntryUploadRequest,
  FileExplorerRequest,
  FileThumbnailRequest,
  FileUploadRequest,
  FileUploadResponse,
  FileSubscribeRequest,
  FileUnsubscribeRequest,
  FileWriteRequest,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../../messages.js";
import { FileUploadStore } from "../../file-upload/index.js";
import type { DownloadTokenStore } from "../../file-download/token-store.js";
import {
  createFolderZipStream,
  FOLDER_ZIP_MIME_TYPE,
  getDownloadableFolderInfo,
} from "../../file-download/folder-zip.js";
import {
  SessionDownloads,
  type SessionDownloadStream,
} from "../../file-download/session-downloads.js";
import {
  createExplorerEntry,
  deleteExplorerEntry,
  duplicateExplorerEntry,
  getDownloadableFileInfo,
  listDirectoryEntries,
  moveStagedUploadIntoWorkspace,
  readExplorerFile,
  renameExplorerEntry,
  streamExplorerFile,
  writeExplorerFile,
} from "../../file-explorer/service.js";
import { workspaceFileObserver, type FileObserver } from "../../file-explorer/observer.js";
import type { ExplorerThumbnailService } from "../../file-explorer/thumbnails/service.js";
import { getProjectIcon } from "../../../utils/project-icon.js";

/**
 * What a workspace file-access request reaches outside its own domain: the
 * outbound message channel (text + binary). `hasBinaryChannel` gates the
 * binary file-explorer transfer path the same way the terminal subsystem does
 * — old clients without a binary channel fall back to inline JSON file content.
 */
export interface WorkspaceFilesSessionHost {
  emit(msg: SessionOutboundMessage, source?: object): void;
  emitBinary(frame: Uint8Array, source?: object): Promise<void>;
  hasBinaryChannel(): boolean;
}

export interface WorkspaceFilesSessionOptions {
  host: WorkspaceFilesSessionHost;
  downloadTokenStore: DownloadTokenStore;
  paseoHome: string;
  logger: pino.Logger;
  fileObserver?: FileObserver;
  /** Directories of the daemon's active workspaces. Entry changes must land inside one. */
  workspaceRoots: () => Promise<readonly string[]>;
  thumbnails: ExplorerThumbnailService;
}

/**
 * The Files panel browses folders outside the workspace read-only. The client hides the
 * controls; this refusal is the rule, for any client.
 */
export const OUTSIDE_WORKSPACE_READ_ONLY_MESSAGE = "Folders outside the workspace are read-only";

async function canonicalPath(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * A client's workspace file-access surface: browsing directories, reading file
 * contents (inline JSON or binary frames), receiving uploads, issuing download
 * tokens, and reading project icons. It owns the upload store and reaches no
 * workspace-git, registry, or subscription state — file I/O scoped to a cwd is
 * the whole concern.
 */
export class WorkspaceFilesSession {
  private readonly host: WorkspaceFilesSessionHost;
  private readonly downloadTokenStore: DownloadTokenStore;
  private readonly logger: pino.Logger;
  private readonly fileUploads: FileUploadStore;
  private readonly fileObserver: FileObserver;
  private readonly workspaceRoots: () => Promise<readonly string[]>;
  private readonly thumbnails: ExplorerThumbnailService;
  private readonly downloads = new SessionDownloads();

  constructor(options: WorkspaceFilesSessionOptions) {
    this.host = options.host;
    this.downloadTokenStore = options.downloadTokenStore;
    this.logger = options.logger;
    this.fileUploads = new FileUploadStore({ paseoHome: options.paseoHome });
    this.fileObserver = options.fileObserver ?? workspaceFileObserver;
    this.workspaceRoots = options.workspaceRoots;
    this.thumbnails = options.thumbnails;
  }

  dispose(): void {
    this.downloads.closeAll();
  }

  /** Null when `root` lies inside an active workspace, otherwise the refusal to send back. */
  private async refuseOutsideWorkspace(root: string): Promise<string | null> {
    const candidate = await canonicalPath(root.trim());
    if (!candidate) return OUTSIDE_WORKSPACE_READ_ONLY_MESSAGE;
    for (const workspaceRoot of await this.workspaceRoots()) {
      const canonicalRoot = await canonicalPath(workspaceRoot);
      if (canonicalRoot && isPathInside(canonicalRoot, candidate)) return null;
    }
    return OUTSIDE_WORKSPACE_READ_ONLY_MESSAGE;
  }

  async handleFileThumbnailRequest(request: FileThumbnailRequest): Promise<void> {
    const { cwd, path: relativePath, requestId } = request;
    try {
      const thumbnail = await this.thumbnails.get({
        root: cwd,
        relativePath,
        maxEdge: request.maxEdge,
      });
      this.host.emit({
        type: "fs.thumbnail.get.response",
        payload: { cwd, path: relativePath, thumbnail, error: null, requestId },
      });
    } catch (error) {
      this.host.emit({
        type: "fs.thumbnail.get.response",
        payload: {
          cwd,
          path: relativePath,
          thumbnail: null,
          error: getErrorMessage(error),
          requestId,
        },
      });
    }
  }

  async handleFileSubscribeRequest(
    request: FileSubscribeRequest,
    ownership: SessionDelivery,
  ): Promise<void> {
    let bootstrap: ReturnType<FileObserver["subscribe"]> | undefined;
    const owner = ownership.begin(
      "files",
      request.subscriptionId,
      async () => {
        await bootstrap?.then(
          (subscription) => subscription.unsubscribe(),
          () => undefined,
        );
      },
      `file:${request.subscriptionId}`,
    );
    let ready = false;
    let pending: FileVersion | null = null;
    const emitVersion = (version: FileVersion) =>
      owner.emit({
        type: "fs.file.update",
        payload: { subscriptionId: owner.responseId, version },
      });
    try {
      bootstrap = this.fileObserver.subscribe(
        { cwd: request.cwd, path: request.path },
        (version) => {
          if (owner.signal.aborted) return;
          if (ready) emitVersion(version);
          else pending = version;
        },
      );
      const subscription = await bootstrap;
      if (owner.signal.aborted) {
        subscription.unsubscribe();
        return;
      }
      this.host.emit({
        type: "fs.file.subscribe.response",
        payload: {
          subscriptionId: owner.responseId,
          initial: subscription.initial,
          requestId: request.requestId,
        },
      });
      ready = true;
      if (pending) emitVersion(pending);
    } catch (error) {
      await owner.release();
      this.host.emit({
        type: "fs.file.subscribe.response",
        payload: {
          subscriptionId: owner.responseId,
          initial: {
            status: "error",
            cwd: request.cwd,
            path: request.path,
            error: getErrorMessage(error),
          },
          requestId: request.requestId,
        },
      });
    }
  }

  async handleFileUnsubscribeRequest(
    request: FileUnsubscribeRequest,
    ownership: SessionDelivery,
  ): Promise<void> {
    await ownership.release(request.subscriptionId);
    this.host.emit({
      type: "fs.file.unsubscribe.response",
      payload: { subscriptionId: request.subscriptionId, requestId: request.requestId },
    });
  }

  async handleFileWriteRequest(request: FileWriteRequest): Promise<void> {
    const result = await writeExplorerFile({
      root: request.cwd,
      relativePath: request.path,
      content: request.content,
      contentEncoding: request.contentEncoding,
      expectedModifiedAt: request.expectedModifiedAt,
      expectedRevision: request.expectedRevision,
    });
    this.host.emit({
      type: "fs.file.write.response",
      payload: { result, requestId: request.requestId },
    });
  }

  async handleFileEntryCreateRequest(request: FileEntryCreateRequest): Promise<void> {
    const refusal = await this.refuseOutsideWorkspace(request.cwd);
    const result = refusal
      ? ({ status: "error", error: refusal } as const)
      : await createExplorerEntry({
          root: request.cwd,
          parentPath: request.parentPath,
          name: request.name,
          kind: request.kind,
        });
    this.host.emit({
      type: "fs.entry.create.response",
      payload: {
        cwd: request.cwd,
        parentPath: request.parentPath,
        path: result.status === "ok" ? result.path : null,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  async handleFileEntryRenameRequest(request: FileEntryRenameRequest): Promise<void> {
    const refusal = await this.refuseOutsideWorkspace(request.cwd);
    const result = refusal
      ? ({ status: "error", error: refusal } as const)
      : await renameExplorerEntry({
          root: request.cwd,
          relativePath: request.path,
          name: request.name,
        });
    this.host.emit({
      type: "fs.entry.rename.response",
      payload: {
        cwd: request.cwd,
        path: request.path,
        renamedPath: result.status === "ok" ? result.path : null,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  async handleFileEntryDuplicateRequest(request: FileEntryDuplicateRequest): Promise<void> {
    const refusal = await this.refuseOutsideWorkspace(request.cwd);
    const result = refusal
      ? ({ status: "error", error: refusal } as const)
      : await duplicateExplorerEntry({
          root: request.cwd,
          relativePath: request.path,
        });
    this.host.emit({
      type: "fs.entry.duplicate.response",
      payload: {
        cwd: request.cwd,
        path: request.path,
        duplicatedPath: result.status === "ok" ? result.path : null,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  async handleFileEntryDeleteRequest(request: FileEntryDeleteRequest): Promise<void> {
    const refusal = await this.refuseOutsideWorkspace(request.cwd);
    const result = refusal
      ? ({ status: "error", error: refusal } as const)
      : await deleteExplorerEntry({
          root: request.cwd,
          relativePath: request.path,
        });
    this.host.emit({
      type: "fs.entry.delete.response",
      payload: {
        cwd: request.cwd,
        path: request.path,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  async handleFileExplorerRequest(request: FileExplorerRequest, source?: object): Promise<void> {
    const { cwd: workspaceCwd, path: requestedPath = ".", mode, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.host.emit(
        {
          type: "file_explorer_response",
          payload: {
            cwd: workspaceCwd,
            path: requestedPath,
            mode,
            directory: null,
            file: null,
            error: "cwd is required",
            requestId,
          },
        },
        source,
      );
      return;
    }

    try {
      if (mode === "list") {
        const directory = await listDirectoryEntries({
          root: cwd,
          relativePath: requestedPath,
        });

        this.host.emit(
          {
            type: "file_explorer_response",
            payload: {
              cwd,
              path: directory.path,
              mode,
              directory,
              file: null,
              error: null,
              requestId,
            },
          },
          source,
        );
      } else {
        if (request.maxBytes) {
          const file = await getDownloadableFileInfo({ root: cwd, relativePath: requestedPath });
          if (file.size > request.maxBytes) {
            throw new Error("File is too large to display");
          }
        }
        if (request.acceptBinary && this.host.hasBinaryChannel()) {
          await streamExplorerFile({ root: cwd, relativePath: requestedPath }, async (file) => {
            await this.host.emitBinary(
              encodeFileTransferFrame({
                opcode: FileTransferOpcode.FileBegin,
                requestId,
                metadata: {
                  mime: file.mimeType,
                  size: file.size,
                  encoding: file.encoding,
                  modifiedAt: file.modifiedAt,
                  revision: file.revision,
                },
              }),
              source,
            );
            for await (const chunk of file.chunks) {
              await this.host.emitBinary(
                encodeFileTransferFrame({
                  opcode: FileTransferOpcode.FileChunk,
                  requestId,
                  payload: chunk,
                }),
                source,
              );
            }
            await this.host.emitBinary(
              encodeFileTransferFrame({
                opcode: FileTransferOpcode.FileEnd,
                requestId,
              }),
              source,
            );
          });
        } else {
          const file = await readExplorerFile({
            root: cwd,
            relativePath: requestedPath,
          });

          this.host.emit(
            {
              type: "file_explorer_response",
              payload: {
                cwd,
                path: file.path,
                mode,
                directory: null,
                file,
                error: null,
                requestId,
              },
            },
            source,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        { err: error, cwd, path: requestedPath },
        `Failed to fulfill file explorer request for workspace ${cwd}`,
      );
      this.host.emit(
        {
          type: "file_explorer_response",
          payload: {
            cwd,
            path: requestedPath,
            mode,
            directory: null,
            file: null,
            error: getErrorMessage(error),
            requestId,
          },
        },
        source,
      );
    }
  }

  handleFileUploadRequest(request: FileUploadRequest, ownership: SessionDelivery): void {
    let cancel: (() => Promise<void>) | undefined;
    const operation = ownership.operation(
      (message) =>
        message.type === "file.upload.response" && message.payload.requestId === request.requestId,
      () => cancel?.(),
    );
    cancel = this.fileUploads.beginUpload(request, operation.source, (response) => {
      if (response) operation.emit(response);
      void operation
        .release()
        .catch((error) => this.logger.error({ err: error }, "Upload cleanup failed"));
    });
  }

  handleFileEntryUploadRequest(request: FileEntryUploadRequest, ownership: SessionDelivery): void {
    let cancel: (() => Promise<void>) | undefined;
    const operation = ownership.operation(
      (message) =>
        message.type === "fs.entry.upload.response" &&
        message.payload.requestId === request.requestId,
      () => cancel?.(),
    );
    cancel = this.fileUploads.beginUpload(
      {
        type: "file.upload.request",
        fileName: request.name,
        mimeType: request.mimeType,
        size: request.size,
        modifiedAt: new Date().toISOString(),
        requestId: request.requestId,
      },
      operation.source,
      (staged) => {
        void this.finishFileEntryUpload({ operation, request, staged });
      },
    );
  }

  private async finishFileEntryUpload(args: {
    operation: OwnedOperation;
    request: FileEntryUploadRequest;
    staged: FileUploadResponse | null;
  }): Promise<void> {
    const { operation, request, staged } = args;
    if (!staged) {
      await operation.release().catch((error) => this.logUploadCleanupError(error));
      return;
    }
    const emitError = (error: string, alreadyExists?: boolean) => {
      operation.emit({
        type: "fs.entry.upload.response",
        payload: {
          cwd: request.cwd,
          parentPath: request.parentPath,
          path: null,
          success: false,
          error,
          alreadyExists,
          requestId: request.requestId,
        },
      });
    };
    try {
      const stagedFile = staged.payload.error ? null : staged.payload.file;
      if (!stagedFile) {
        emitError(staged.payload.error ?? "Upload failed.");
        return;
      }
      const refusal = await this.refuseOutsideWorkspace(request.cwd);
      if (refusal) {
        emitError(refusal);
        return;
      }
      const result = await moveStagedUploadIntoWorkspace({
        root: request.cwd,
        parentPath: request.parentPath,
        name: request.name,
        stagedPath: stagedFile.path,
        overwrite: request.overwrite ?? false,
      });
      if (result.status === "ok") {
        operation.emit({
          type: "fs.entry.upload.response",
          payload: {
            cwd: request.cwd,
            parentPath: request.parentPath,
            path: result.path,
            success: true,
            error: null,
            requestId: request.requestId,
          },
        });
      } else {
        emitError(result.error, result.alreadyExists);
      }
    } catch (error) {
      emitError(getErrorMessage(error));
    } finally {
      const stagedFile = staged.payload.file;
      if (stagedFile) {
        await this.fileUploads
          .discardCompletedUpload(stagedFile.id)
          .catch((error) => this.logUploadCleanupError(error));
      }
      await operation.release().catch((error) => this.logUploadCleanupError(error));
    }
  }

  private logUploadCleanupError(error: unknown): void {
    this.logger.error({ err: error }, "Upload cleanup failed");
  }

  async handleFileTransferFrame(frame: FileTransferFrame, source: object): Promise<void> {
    await this.fileUploads.receiveFrame(frame, source);
  }

  async handleProjectIconRequest(
    request: Extract<SessionInboundMessage, { type: "project_icon_request" }>,
  ): Promise<void> {
    const { cwd, requestId } = request;

    try {
      const icon = await getProjectIcon(cwd);
      this.host.emit({
        type: "project_icon_response",
        payload: {
          cwd,
          icon,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.host.emit({
        type: "project_icon_response",
        payload: {
          cwd,
          icon: null,
          error: getErrorMessage(error),
          requestId,
        },
      });
    }
  }

  async handleFileDownloadTokenRequest(request: FileDownloadTokenRequest): Promise<void> {
    const { cwd: workspaceCwd, path: requestedPath, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.host.emit({
        type: "file_download_token_response",
        payload: {
          cwd: workspaceCwd,
          path: requestedPath,
          token: null,
          fileName: null,
          mimeType: null,
          size: null,
          error: "cwd is required",
          requestId,
        },
      });
      return;
    }

    this.logger.debug(
      { cwd, path: requestedPath },
      `Handling file download token request for workspace ${cwd} (${requestedPath})`,
    );

    try {
      const info = await getDownloadableFileInfo({
        root: cwd,
        relativePath: requestedPath,
      });

      const entry = this.downloadTokenStore.issueToken({
        kind: "file",
        path: info.path,
        absolutePath: info.absolutePath,
        fileName: info.fileName,
        mimeType: info.mimeType,
        size: info.size,
      });

      this.host.emit({
        type: "file_download_token_response",
        payload: {
          cwd,
          path: info.path,
          token: entry.token,
          fileName: entry.fileName,
          mimeType: entry.mimeType,
          size: entry.size,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.logger.error(
        { err: error, cwd, path: requestedPath },
        `Failed to issue download token for workspace ${cwd}`,
      );
      this.host.emit({
        type: "file_download_token_response",
        payload: {
          cwd,
          path: requestedPath,
          token: null,
          fileName: null,
          mimeType: null,
          size: null,
          error: getErrorMessage(error),
          requestId,
        },
      });
    }
  }

  async handleFolderDownloadTokenRequest(request: FolderDownloadTokenRequest): Promise<void> {
    const cwd = request.cwd.trim();
    try {
      if (!cwd) throw new Error("cwd is required");
      const folder = await getDownloadableFolderInfo({ root: cwd, relativePath: request.path });
      const entry = this.downloadTokenStore.issueToken({
        kind: "folder",
        path: folder.path,
        absolutePath: folder.absolutePath,
        rootPath: folder.rootPath,
        fileName: folder.fileName,
        includeHidden: request.includeHidden ?? true,
      });
      this.host.emit({
        type: "fs.folder.get_download_token.response",
        payload: {
          cwd,
          path: folder.path,
          token: entry.token,
          fileName: entry.fileName,
          error: null,
          requestId: request.requestId,
        },
      });
    } catch (error) {
      this.logger.error(
        { err: error, cwd, path: request.path },
        `Failed to issue folder download token for workspace ${cwd}`,
      );
      this.host.emit({
        type: "fs.folder.get_download_token.response",
        payload: {
          cwd: request.cwd,
          path: request.path,
          token: null,
          fileName: null,
          error: getErrorMessage(error),
          requestId: request.requestId,
        },
      });
    }
  }

  /** Opens a file or a folder's zip for the client to pull with fs.download.read. */
  async handleDownloadOpenRequest(request: DownloadOpenRequest): Promise<void> {
    const { requestId } = request;
    const cwd = request.cwd.trim();
    try {
      if (!cwd) throw new Error("cwd is required");
      if (!this.host.hasBinaryChannel())
        throw new Error("Update the app to download over this connection.");
      const ranged = request.offset !== undefined || request.length !== undefined;
      if (ranged && request.kind === "folder")
        throw new Error("A byte range applies to a file only.");
      const stream =
        request.kind === "folder"
          ? await openFolderDownload(cwd, request.path, request.includeHidden ?? true)
          : await openFileDownload(cwd, request.path, {
              offset: request.offset ?? 0,
              length: request.length ?? null,
            });
      const downloadId = this.downloads.open(stream);
      this.host.emit({
        type: "fs.download.open.response",
        payload: {
          downloadId,
          fileName: stream.fileName,
          mimeType: stream.mimeType,
          size: stream.size,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.logger.warn(
        { err: error, cwd, path: request.path, kind: request.kind },
        `Failed to open download for workspace ${cwd}`,
      );
      this.host.emit({
        type: "fs.download.open.response",
        payload: {
          downloadId: null,
          fileName: null,
          mimeType: null,
          size: null,
          error: getErrorMessage(error),
          requestId,
        },
      });
    }
  }

  async handleDownloadReadRequest(request: DownloadReadRequest, source?: object): Promise<void> {
    const { downloadId, requestId } = request;
    try {
      const slice = await this.downloads.read(
        downloadId,
        Math.min(request.maxBytes, MAX_READ_BYTES),
      );
      for (const chunk of slice.chunks) {
        await this.host.emitBinary(
          encodeFileTransferFrame({
            opcode: FileTransferOpcode.FileChunk,
            requestId,
            payload: chunk,
          }),
          source,
        );
      }
      this.host.emit(
        {
          type: "fs.download.read.response",
          payload: { downloadId, bytes: slice.bytes, done: slice.done, error: null, requestId },
        },
        source,
      );
    } catch (error) {
      // A frame that failed to send leaves the client short; the stream cannot resume.
      this.downloads.close(downloadId);
      this.logger.warn({ err: error, downloadId }, "Failed to read download");
      this.host.emit(
        {
          type: "fs.download.read.response",
          payload: { downloadId, bytes: 0, done: false, error: getErrorMessage(error), requestId },
        },
        source,
      );
    }
  }

  async handleDownloadCloseRequest(request: DownloadCloseRequest): Promise<void> {
    this.downloads.close(request.downloadId);
    this.host.emit({
      type: "fs.download.close.response",
      payload: { downloadId: request.downloadId, error: null, requestId: request.requestId },
    });
  }
}

/** One read never sends more than this, whatever the client asks for. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_CHUNK_BYTES = 256 * 1024;
const FILE_OPEN_FLAGS =
  process.platform === "win32"
    ? fsConstants.O_RDONLY
    : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;

interface FileByteRange {
  offset: number;
  /** `null` reads to the end of the file. */
  length: number | null;
}

async function openFileDownload(
  cwd: string,
  relativePath: string,
  range: FileByteRange,
): Promise<SessionDownloadStream> {
  // Same path safety and canonical target as the HTTP token route.
  const info = await getDownloadableFileInfo({ root: cwd, relativePath });
  const handle = await fs.open(info.absolutePath, FILE_OPEN_FLAGS);
  const stats = await handle.stat().catch(async (error: unknown) => {
    await handle.close();
    throw error;
  });
  if (!stats.isFile()) {
    await handle.close();
    throw new Error("Requested path is not a file");
  }
  if (range.offset > stats.size) {
    await handle.close();
    throw new Error("The range starts past the end of the file.");
  }
  // Stop at the size sent in the open response, so a file that grows meanwhile still matches.
  const end = Math.min(stats.size, range.offset + (range.length ?? stats.size));
  const size = end - range.offset;
  if (size === 0) await handle.close();
  return {
    fileName: info.fileName,
    mimeType: info.mimeType,
    size,
    readable:
      size === 0
        ? Readable.from([])
        : handle.createReadStream({
            highWaterMark: DOWNLOAD_CHUNK_BYTES,
            start: range.offset,
            end: end - 1,
          }),
    abort: new AbortController(),
  };
}

async function openFolderDownload(
  cwd: string,
  relativePath: string,
  includeHidden: boolean,
): Promise<SessionDownloadStream> {
  const folder = await getDownloadableFolderInfo({ root: cwd, relativePath });
  const abort = new AbortController();
  return {
    fileName: folder.fileName,
    mimeType: FOLDER_ZIP_MIME_TYPE,
    size: null,
    readable: createFolderZipStream({ ...folder, includeHidden }, { signal: abort.signal }),
    abort,
  };
}
