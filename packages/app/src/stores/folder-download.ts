import * as LegacyFileSystem from "expo-file-system/legacy";
import type { HostProfile } from "@/types/host-connection";
import { isWeb } from "@/constants/platform";
import { i18n } from "@/i18n/i18next";
import type { PrepareDownloadDestination } from "@/downloads/download-destination";
import type { SessionDownloadStream } from "@/downloads/session-download";
import {
  buildDownloadUrl,
  resolveDaemonDownloadTarget,
  resolveDownloadTargetFile,
  shareSavedFile,
  streamSessionDownload,
  triggerBrowserDownload,
  useDownloadStore,
  type Download,
} from "@/stores/download-store";

const ZIP_MIME_TYPE = "application/zip";

export interface StartFolderDownloadParams {
  serverId: string;
  scopeId: string;
  /** Shown until the daemon answers with the zip's name. */
  fileName: string;
  daemonProfile: HostProfile | undefined;
  /** Connection the host runtime is using right now; `null` while disconnected. */
  activeConnectionId: string | null;
  requestToken: () => Promise<{ token: string | null; fileName: string | null }>;
  /** Streams the zip over the session socket; used when no direct HTTP endpoint is active. */
  openStream: (signal: AbortSignal) => Promise<SessionDownloadStream>;
  prepareDestination?: PrepareDownloadDestination;
}

/**
 * Downloads a folder as the zip the daemon streams, through the same paths as a file: the HTTP
 * token route over a direct TCP connection, the session socket over anything else. Over HTTP
 * the browser or the native downloader writes the zip to disk as it arrives; over the session
 * socket the app pulls it a slice at a time and writes each slice before asking for the next.
 * Neither path has a size limit.
 */
export async function startFolderDownload({
  serverId,
  scopeId,
  fileName,
  daemonProfile,
  activeConnectionId,
  requestToken,
  openStream,
  prepareDestination,
}: StartFolderDownloadParams): Promise<void> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const download: Download = {
    id,
    serverId,
    scopeId,
    fileName,
    status: "downloading",
    startedAt: Date.now(),
  };
  useDownloadStore.setState((state) => ({
    downloads: new Map(state.downloads).set(id, download),
    activeDownloadId: id,
  }));
  const store = useDownloadStore.getState();

  const downloadTarget = resolveDaemonDownloadTarget(daemonProfile, activeConnectionId);
  if (!downloadTarget) {
    await streamSessionDownload({ id, fileName, open: openStream, prepareDestination });
    return;
  }
  try {
    if (!downloadTarget.baseUrl) throw new Error(i18n.t("downloads.hostUnavailable"));

    const tokenResponse = await requestToken();
    if (!tokenResponse.token) throw new Error(i18n.t("downloads.requestTokenFailed"));
    const zipName = tokenResponse.fileName ?? fileName;
    const downloadUrl = buildDownloadUrl(
      downloadTarget.baseUrl,
      tokenResponse.token,
      isWeb ? downloadTarget.authCredentials : null,
    );
    if (isWeb) {
      triggerBrowserDownload(downloadUrl, zipName);
      store.completeDownload(id);
      return;
    }

    const targetFile = resolveDownloadTargetFile(zipName);
    const result = await LegacyFileSystem.downloadAsync(
      downloadUrl,
      targetFile.uri,
      downloadTarget.authHeader
        ? { headers: { Authorization: downloadTarget.authHeader } }
        : undefined,
    );
    if (result.status !== 200) {
      throw new Error(i18n.t("downloads.failed"));
    }
    store.completeDownload(id);
    await shareSavedFile(result.uri, ZIP_MIME_TYPE, zipName);
  } catch (error) {
    const message = error instanceof Error ? error.message : i18n.t("downloads.failed");
    if (isWeb) console.warn("[DownloadStore] Folder download failed:", message);
    store.failDownload(id, message);
  }
}
