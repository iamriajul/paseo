import { create } from "zustand";
import * as LegacyFileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import type { HostProfile } from "@/types/host-connection";
import { buildDaemonWebSocketUrl } from "@/utils/daemon-endpoints";
import {
  prepareDownloadDestination,
  type PrepareDownloadDestination,
} from "@/downloads/download-destination";
import { resolveDownloadTargetFile, triggerBrowserDownload } from "@/downloads/save-file";
import { runSessionDownload, type SessionDownloadStream } from "@/downloads/session-download";
import { isWeb } from "@/constants/platform";
import { i18n } from "@/i18n/i18next";

export { resolveDownloadTargetFile, triggerBrowserDownload } from "@/downloads/save-file";

interface DownloadProgress {
  /** `null` while the total is unknown (a folder's zip). */
  percent: number | null;
  bytesWritten: number;
  totalBytes: number | null;
  speed: number;
  eta: number | null;
}

// COMPAT(downloadStream): added in v0.15.911, drop after 2027-05-11 with readFile below.
// Daemons without fs.download.* send a session download whole, and the client holds it in memory
// two to three times over (chunks, the concatenated bytes, the Blob or native write).
export const MAX_SESSION_DOWNLOAD_BYTES = 64 * 1024 * 1024;

export interface DownloadedBytes {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string | null;
}

export interface Download {
  id: string;
  serverId: string;
  scopeId: string;
  fileName: string;
  status: "downloading" | "complete" | "error";
  message?: string;
  /** Session downloads stream to disk and can be stopped from the toast. */
  cancellable?: boolean;
  progress?: DownloadProgress;
  startedAt: number;
}

interface DownloadState {
  downloads: Map<string, Download>;
  activeDownloadId: string | null;

  startDownload: (params: {
    serverId: string;
    scopeId: string;
    fileName: string;
    path: string;
    daemonProfile: HostProfile | undefined;
    /** Connection the host runtime is using right now; `null` while disconnected. */
    activeConnectionId: string | null;
    requestFileDownloadToken: (path: string) => Promise<{
      token: string | null;
      fileName: string | null;
      mimeType: string | null;
      size: number | null;
      error: string | null;
    }>;
    /**
     * Streams the file over the session socket when no direct HTTP endpoint is active. `null`
     * for a daemon without `features.downloadStream`, which falls back to `readFile`.
     */
    openStream: ((signal: AbortSignal) => Promise<SessionDownloadStream>) | null;
    /** Reads the whole file over the session socket; the fallback for older daemons. */
    readFile: (path: string, maxBytes: number) => Promise<{ bytes: Uint8Array; size: number }>;
    saveFile?: typeof saveDownloadedBytes;
    prepareDestination?: PrepareDownloadDestination;
  }) => Promise<void>;

  updateProgress: (id: string, progress: DownloadProgress) => void;
  /** Stops a cancellable download and removes it; its partial file is deleted. */
  cancelDownload: (id: string) => void;
  completeDownload: (id: string) => void;
  failDownload: (id: string, message: string) => void;
  dismissDownload: (id: string) => void;
  dismissAllCompleted: () => void;
}

function generateDownloadId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const useDownloadStore = create<DownloadState>()((set, get) => ({
  downloads: new Map(),
  activeDownloadId: null,

  startDownload: async ({
    serverId,
    scopeId,
    fileName,
    path,
    daemonProfile,
    activeConnectionId,
    requestFileDownloadToken,
    openStream,
    readFile,
    saveFile = saveDownloadedBytes,
    prepareDestination = prepareDownloadDestination,
  }) => {
    const id = generateDownloadId();
    const download: Download = {
      id,
      serverId,
      scopeId,
      fileName,
      status: "downloading",
      startedAt: Date.now(),
    };

    set((state) => ({
      downloads: new Map(state.downloads).set(id, download),
      activeDownloadId: id,
    }));

    const downloadTarget = resolveDaemonDownloadTarget(daemonProfile, activeConnectionId);
    if (!downloadTarget && openStream) {
      // Relay, SSH, socket and pipe hosts have no HTTP endpoint (#543): stream over the session.
      await streamSessionDownload({ id, fileName, open: openStream, prepareDestination });
      return;
    }

    try {
      const tokenResponse = await requestFileDownloadToken(path);
      if (tokenResponse.error || !tokenResponse.token) {
        throw new Error(tokenResponse.error ?? i18n.t("downloads.requestTokenFailed"));
      }

      const resolvedFileName = tokenResponse.fileName ?? fileName;
      if (!downloadTarget) {
        // COMPAT(downloadStream): added in v0.15.911, drop after 2027-05-11.
        const savedUri = await readWholeFileOverSession({
          path,
          fileName: resolvedFileName,
          mimeType: tokenResponse.mimeType,
          size: tokenResponse.size,
          readFile,
          saveFile,
        });
        get().completeDownload(id);
        if (savedUri !== null) {
          await shareSavedFile(savedUri, tokenResponse.mimeType, resolvedFileName);
        }
        return;
      }
      if (!downloadTarget.baseUrl) {
        throw new Error(i18n.t("downloads.hostUnavailable"));
      }

      const downloadUrl = buildDownloadUrl(
        downloadTarget.baseUrl,
        tokenResponse.token,
        isWeb ? downloadTarget.authCredentials : null,
      );

      if (isWeb) {
        triggerBrowserDownload(downloadUrl, resolvedFileName);
        get().completeDownload(id);
        return;
      }

      const downloadStartTime = Date.now();
      const targetFile = resolveDownloadTargetFile(resolvedFileName);
      const downloadResumable = LegacyFileSystem.createDownloadResumable(
        downloadUrl,
        targetFile.uri,
        downloadTarget.authHeader
          ? { headers: { Authorization: downloadTarget.authHeader } }
          : undefined,
        (data) => {
          const now = Date.now();
          const { totalBytesWritten, totalBytesExpectedToWrite } = data;

          if (totalBytesExpectedToWrite <= 0) {
            return;
          }

          const percent = totalBytesWritten / totalBytesExpectedToWrite;
          const elapsed = (now - downloadStartTime) / 1000;
          const speed = elapsed > 0 ? totalBytesWritten / elapsed : 0;
          const remaining = totalBytesExpectedToWrite - totalBytesWritten;
          const eta = speed > 0 ? remaining / speed : 0;

          get().updateProgress(id, {
            percent,
            bytesWritten: totalBytesWritten,
            totalBytes: totalBytesExpectedToWrite,
            speed,
            eta,
          });
        },
      );

      const result = await downloadResumable.downloadAsync();
      if (!result) {
        throw new Error(i18n.t("downloads.cancelled"));
      }

      get().completeDownload(id);

      await shareSavedFile(result.uri, tokenResponse.mimeType, resolvedFileName);
    } catch (error) {
      const message = error instanceof Error ? error.message : i18n.t("downloads.failed");
      if (isWeb) {
        console.warn("[DownloadStore] Download failed:", message);
        get().failDownload(id, message);
        return;
      }
      get().failDownload(id, message);
    }
  },

  cancelDownload: (id) => {
    downloadCancellers.get(id)?.abort();
  },

  updateProgress: (id, progress) => {
    set((state) => {
      const download = state.downloads.get(id);
      if (!download || download.status !== "downloading") {
        return state;
      }
      const updated = new Map(state.downloads);
      updated.set(id, { ...download, progress });
      return { downloads: updated };
    });
  },

  completeDownload: (id) => {
    set((state) => {
      const download = state.downloads.get(id);
      if (!download) {
        return state;
      }
      const updated = new Map(state.downloads);
      updated.set(id, { ...download, status: "complete", cancellable: false });
      return { downloads: updated };
    });
  },

  failDownload: (id, message) => {
    set((state) => {
      const download = state.downloads.get(id);
      if (!download) {
        return state;
      }
      const updated = new Map(state.downloads);
      updated.set(id, { ...download, status: "error", message, cancellable: false });
      return { downloads: updated };
    });
  },

  dismissDownload: (id) => {
    set((state) => {
      const updated = new Map(state.downloads);
      updated.delete(id);
      const newActiveId =
        state.activeDownloadId === id ? findMostRecentDownloadId(updated) : state.activeDownloadId;
      return { downloads: updated, activeDownloadId: newActiveId };
    });
  },

  dismissAllCompleted: () => {
    set((state) => {
      const updated = new Map(state.downloads);
      for (const [id, download] of updated) {
        if (download.status !== "downloading") {
          updated.delete(id);
        }
      }
      let newActiveId: string | null;
      if (!state.activeDownloadId) newActiveId = null;
      else if (updated.has(state.activeDownloadId)) newActiveId = state.activeDownloadId;
      else newActiveId = findMostRecentDownloadId(updated);
      return { downloads: updated, activeDownloadId: newActiveId };
    });
  },
}));

/** How daemons without fs.download.* send a file over the session: whole, capped. */
async function readWholeFileOverSession({
  path,
  fileName,
  mimeType,
  size: advertisedSize,
  readFile,
  saveFile,
}: {
  path: string;
  fileName: string;
  mimeType: string | null;
  size: number | null;
  readFile: (path: string, maxBytes: number) => Promise<{ bytes: Uint8Array; size: number }>;
  saveFile: typeof saveDownloadedBytes;
}): Promise<string | null> {
  if (typeof advertisedSize === "number" && advertisedSize > MAX_SESSION_DOWNLOAD_BYTES) {
    throw new Error(i18n.t("composer.errors.fileTooLarge", { fileName, size: "64 MB" }));
  }
  const { bytes, size } = await readFile(path, MAX_SESSION_DOWNLOAD_BYTES);
  // A daemon without a binary channel answers `encoding: "none"` for a binary file: no
  // content, real size. Never save that as a complete download.
  if (bytes.byteLength !== size) {
    throw new Error(
      `File transfer incomplete: expected ${size} bytes, received ${bytes.byteLength}.`,
    );
  }
  return saveFile({ bytes, fileName, mimeType });
}

/** Aborts a running session download; keyed by download id while one runs. */
const downloadCancellers = new Map<string, AbortController>();

function patchDownload(id: string, patch: Partial<Download>) {
  useDownloadStore.setState((state) => {
    const download = state.downloads.get(id);
    if (!download) return state;
    return { downloads: new Map(state.downloads).set(id, { ...download, ...patch }) };
  });
}

/**
 * Runs a download read over the session socket for an entry already in the store, then shares
 * the file on native. Call it before any `await`: on web it opens the save prompt, which needs
 * the tap's user activation.
 */
export async function streamSessionDownload({
  id,
  fileName,
  open,
  prepareDestination = prepareDownloadDestination,
}: {
  id: string;
  fileName: string;
  open: (signal: AbortSignal) => Promise<SessionDownloadStream>;
  prepareDestination?: PrepareDownloadDestination;
}): Promise<void> {
  const destination = prepareDestination(fileName);
  const abort = new AbortController();
  downloadCancellers.set(id, abort);
  patchDownload(id, { cancellable: true });
  const store = useDownloadStore.getState();
  try {
    const result = await runSessionDownload({
      destination,
      open,
      signal: abort.signal,
      onStart: (stream) => patchDownload(id, { fileName: stream.fileName }),
      onProgress: ({ bytesWritten, totalBytes, speed }) => {
        const remaining = totalBytes === null ? null : totalBytes - bytesWritten;
        store.updateProgress(id, {
          percent: totalBytes ? bytesWritten / totalBytes : null,
          bytesWritten,
          totalBytes,
          speed,
          eta: remaining === null || speed <= 0 ? null : remaining / speed,
        });
      },
    });
    if (result.status === "cancelled") {
      store.dismissDownload(id);
      return;
    }
    store.completeDownload(id);
    if (result.uri !== null) await shareSavedFile(result.uri, result.mimeType, result.fileName);
  } catch (error) {
    const message = error instanceof Error ? error.message : i18n.t("downloads.failed");
    console.warn("[DownloadStore] Session download failed:", message);
    store.failDownload(id, message);
  } finally {
    downloadCancellers.delete(id);
  }
}

function findMostRecentDownloadId(downloads: Map<string, Download>): string | null {
  let mostRecent: Download | null = null;
  for (const download of downloads.values()) {
    if (!mostRecent || download.startedAt > mostRecent.startedAt) {
      mostRecent = download;
    }
  }
  return mostRecent?.id ?? null;
}

export interface DownloadTarget {
  baseUrl: string | null;
  authHeader: string | null;
  authCredentials: { username: string; password: string } | null;
}

/**
 * The HTTP download route is only reachable over a direct TCP connection. Returns `null` when
 * the connection in use is anything else (relay, SSH, socket, pipe, or none yet), so the caller
 * reads the file over the session socket instead.
 */
export function resolveDaemonDownloadTarget(
  daemon: HostProfile | undefined,
  activeConnectionId: string | null,
): DownloadTarget | null {
  const connection = daemon?.connections.find((conn) => conn.id === activeConnectionId);
  if (connection?.type !== "directTcp") {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(
      buildDaemonWebSocketUrl(connection.endpoint, { useTls: connection.useTls ?? false }),
    );
  } catch {
    return { baseUrl: null, authHeader: null, authCredentials: null };
  }

  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  }

  let authCredentials: { username: string; password: string } | null = null;
  if (parsed.username || parsed.password) {
    authCredentials = {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
    parsed.username = "";
    parsed.password = "";
  }

  parsed.pathname = parsed.pathname.replace(/\/ws\/?$/, "/");

  const baseUrl = parsed.origin;
  const authHeader = authCredentials
    ? `Basic ${btoa(`${authCredentials.username}:${authCredentials.password}`)}`
    : null;

  return { baseUrl, authHeader, authCredentials };
}

export function buildDownloadUrl(
  baseUrl: string,
  token: string,
  authCredentials: { username: string; password: string } | null,
): string {
  const url = new URL("/api/files/download", baseUrl);
  url.searchParams.set("token", token);
  if (authCredentials) {
    url.username = authCredentials.username;
    url.password = authCredentials.password;
  }
  return url.toString();
}

/**
 * Saves bytes read over the session. Web and Electron hand them to the browser's download
 * manager and return `null`; native writes the file and returns its URI for the share sheet.
 */
export async function saveDownloadedBytes({
  bytes,
  fileName,
  mimeType,
}: DownloadedBytes): Promise<string | null> {
  if (isWeb) {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const url = URL.createObjectURL(
      new Blob([buffer], { type: mimeType ?? "application/octet-stream" }),
    );
    triggerBrowserDownload(url, fileName);
    // The browser may still be reading the blob while its save prompt is open.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return null;
  }
  // Resolve and write in one tick so two downloads of the same name cannot pick the same path.
  const targetFile = resolveDownloadTargetFile(fileName);
  targetFile.write(bytes);
  return targetFile.uri;
}

export async function shareSavedFile(
  uri: string,
  mimeType: string | null,
  fileName: string,
): Promise<void> {
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: mimeType ?? undefined,
      dialogTitle: fileName
        ? i18n.t("downloads.shareFileNamed", { fileName })
        : i18n.t("downloads.shareFile"),
    });
  }
}

export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) {
    return `${Math.round(bytesPerSecond)} B/s`;
  }
  if (bytesPerSecond < 1024 * 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  }
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function formatEta(seconds: number): string {
  if (seconds < 1) {
    return "< 1s";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}
